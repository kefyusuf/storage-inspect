const BLOCK = 32768;
const TYPE_FULL = 1;
const TYPE_FIRST = 2;
const TYPE_MIDDLE = 3;
const TYPE_LAST = 4;
const OP_DELETE = 0;
const OP_PUT = 1;
const FORMAT_UTF16 = 0;
const FORMAT_LATIN1 = 1;

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = buf[i++];
    if (byte === undefined) return { value: -1, next: i, oob: true };
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: result, next: i };
}

// LevelDB WAL framing: 32KB blocks, each record = CRC(4) + Length(2) + Type(1) + data.
// Full = self-contained; First/Middle/Last = a logical record split across blocks.
// CRC is intentionally not validated (this is a best-effort reader).
export function readRecords(buf) {
  const out = [];
  let fragment = null;
  for (let b = 0; b < buf.length; b += BLOCK) {
    const block = buf.subarray(b, Math.min(b + BLOCK, buf.length));
    let off = 0;
    while (off + 7 <= block.length) {
      const type = block[off + 6];
      if (type === 0) break; // zero padding -> rest of block is empty
      const len = block.readUInt16LE(off + 4);
      if (off + 7 + len > block.length) break; // truncated tail
      const data = block.subarray(off + 7, off + 7 + len);
      if (type === TYPE_FULL) out.push(Buffer.from(data));
      else if (type === TYPE_FIRST) fragment = Buffer.from(data);
      else if (type === TYPE_MIDDLE) fragment = Buffer.concat([fragment, data]);
      else if (type === TYPE_LAST) {
        out.push(Buffer.concat([fragment, data]));
        fragment = null;
      }
      off += 7 + len;
    }
  }
  return out;
}

// LevelDB WriteBatch payload: sequence(8) + count(4), then per entry the tag byte
// first, a varstring key and — for a put — a varstring value:
//   kTypeValue varstring varstring | kTypeDeletion varstring   (db/write_batch.cc)
// A payload that does not describe itself exactly is dropped whole: a misaligned
// parse yields entries that look like real origins but are not.
export function parseWriteBatch(payload) {
  if (payload.length < 12) return [];
  const count = payload.readUInt32LE(8);
  const entries = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const op = payload[off++];
    if (op !== OP_PUT && op !== OP_DELETE) return [];
    const key = readVarString(payload, off);
    if (!key) return [];
    off = key.next;
    let value = null;
    if (op === OP_PUT) {
      const v = readVarString(payload, off);
      if (!v) return [];
      off = v.next;
      value = v.data;
    }
    entries.push({ op: op === OP_PUT ? "put" : "delete", key: key.data, value });
  }
  return off === payload.length ? entries : [];
}

function readVarString(buf, off) {
  const len = readVarint(buf, off);
  if (len.oob || len.next + len.value > buf.length) return null;
  return { data: buf.subarray(len.next, len.next + len.value), next: len.next + len.value };
}

// After the 0x00 that ends the storage key — and again in front of every value —
// Blink writes a single StorageFormat byte before the script-visible text
// (cached_storage_area.cc: UTF16 = 0, Latin1 = 1). It is serialized, so exactly one
// byte is consumed: a name that itself starts with U+0001 is stored as 01 01 ...
function decodeText(buf) {
  const format = buf[0];
  const payload = buf.subarray(1);
  if (format === FORMAT_LATIN1) return { text: payload.toString("latin1"), bytes: payload.length };
  if (format === FORMAT_UTF16 && payload.length % 2 === 0) return { text: payload.toString("utf16le"), bytes: payload.length };
  return null;
}

// Map rows are "<storage_key>\0<format><item name>"; metadata rows ("META:",
// "METAACCESS:") hold no 0x00 at all and are not user data.
//
// A value is only ever measured: its format byte is validated and its payload
// length taken, but the text is never decoded, because nothing in this program
// prints it — the same stance cookies.js takes with `length(value)` in SQL.
function valueLength(buf) {
  const format = buf[0];
  const payload = buf.subarray(1);
  if (format === FORMAT_LATIN1) return payload.length;
  if (format === FORMAT_UTF16 && payload.length % 2 === 0) return payload.length;
  return null;
}

export function decodeEntry(keyBuf, valueBuf) {
  const sep = keyBuf.indexOf(0x00);
  if (sep === -1) return null;
  const name = decodeText(keyBuf.subarray(sep + 1));
  if (!name) return null;
  const value = valueBuf === null ? 0 : valueLength(valueBuf);
  if (value === null) return null;
  return {
    origin: keyBuf.subarray(0, sep).toString("utf8"),
    key: name.text,
    size: name.bytes + value,
  };
}

// Best-effort: reads the LevelDB write-ahead log (*.log) only. Entries compacted
// into .ldb (Snappy) files are NOT covered — see README "Out of scope".
export function readLocalStorage({ listFiles, readFile }) {
  const logs = listFiles().filter((f) => f.endsWith(".log")).sort();
  const byEntry = new Map();

  for (const name of logs) {
    const buf = readFile(name);
    for (const record of readRecords(buf)) {
      for (const { op, key, value } of parseWriteBatch(record)) {
        const entry = decodeEntry(key, value);
        if (!entry) continue;
        const id = `${entry.origin}\u0000${entry.key}`;
        if (op === "delete") {
          byEntry.delete(id);
          continue;
        }
        byEntry.set(id, entry);
      }
    }
  }
  return [...byEntry.values()];
}

function hostOf(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

export function filterLocalStorage(entries, { domain } = {}) {
  if (!domain) return entries.slice();
  const target = domain.replace(/^\./, "");
  return entries.filter((e) => {
    const host = hostOf(e.origin);
    return host === target || host.endsWith(`.${target}`);
  });
}

export function groupStorage(entries) {
  const map = new Map();
  for (const e of entries) {
    const g = map.get(e.origin) ?? { origin: e.origin, count: 0, size: 0 };
    g.count += 1;
    g.size += e.size;
    map.set(e.origin, g);
  }
  return [...map.values()].sort((a, b) => b.size - a.size);
}
