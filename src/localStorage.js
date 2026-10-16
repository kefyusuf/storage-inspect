const BLOCK = 32768;
const TYPE_FULL = 1;
const TYPE_FIRST = 2;
const TYPE_MIDDLE = 3;
const TYPE_LAST = 4;

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = buf[i++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: result >>> 0, next: i };
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

// WriteBatch payload: sequence(8) + count(4) + per-entry: varint(valueLen) + varint(keyLen) + key + value.
export function parseWriteBatch(payload) {
  const count = payload.readUInt32LE(8);
  let off = 12;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const v = readVarint(payload, off);
    off = v.next;
    const k = readVarint(payload, off);
    off = k.next;
    const key = payload.subarray(off, off + k.value);
    off += k.value;
    const value = payload.subarray(off, off + v.value);
    off += v.value;
    entries.push({ key, value });
  }
  return entries;
}

export function decodeEntry(keyBuf, valueBuf) {
  const sep = keyBuf.indexOf(0x00);
  const origin = keyBuf.subarray(0, sep).toString("utf8");
  const key = keyBuf.subarray(sep + 1).toString("utf8");
  return { origin, key, value: valueBuf.toString("utf16le") };
}

// Best-effort: reads the LevelDB write-ahead log (*.log) only. Entries compacted
// into .ldb (Snappy) files are NOT covered — see README "Out of scope".
export function readLocalStorage({ listFiles, readFile }) {
  const logs = listFiles().filter((f) => f.endsWith(".log")).sort();
  const byEntry = new Map();

  for (const name of logs) {
    const buf = readFile(name);
    for (const record of readRecords(buf)) {
      for (const { key, value } of parseWriteBatch(record)) {
        const sep = key.indexOf(0x00);
        if (sep === -1) continue;
        const origin = key.subarray(0, sep).toString("utf8");
        if (origin.startsWith("META:")) continue; // metadata rows, not user data
        const decoded = decodeEntry(key, value);
        const id = `${origin}\u0000${decoded.key}`;
        byEntry.set(id, { origin, key: decoded.key, value: decoded.value, size: decoded.key.length + value.length });
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
