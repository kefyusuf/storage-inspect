import { test } from "node:test";
import assert from "node:assert/strict";
import { readRecords, parseWriteBatch, decodeEntry, readLocalStorage, filterLocalStorage, groupStorage } from "../src/localStorage.js";

const BLOCK = 32768;

// ---- test-side encoders (mirror the on-disk format) ----
function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function record(type, data) {
  const head = Buffer.alloc(7);
  head.writeUInt32LE(0, 0); // CRC (reader ignores)
  head.writeUInt16LE(data.length, 4);
  head[6] = type;
  return Buffer.concat([head, data]);
}

// LevelDB WriteBatch payload (db/write_batch.cc): sequence(8) + count(4), then per
// entry a tag byte FIRST, then varstring(key) and, for a put, varstring(value):
//   kTypeValue    varstring varstring
//   kTypeDeletion varstring
function buildWriteBatch(entries, seq = 1) {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(seq), 0);
  head.writeUInt32LE(entries.length, 8);
  const parts = [head];
  for (const { key, value, op = "put" } of entries) {
    parts.push(Buffer.from([op === "delete" ? 0 : 1]), varint(key.length), key);
    if (op !== "delete") parts.push(varint(value.length), value);
  }
  return Buffer.concat(parts);
}

// Blink writes the script-visible text with one StorageFormat byte in front of it,
// both in map keys (after the 0x00 that ends the storage key) and in values:
//   UTF16 = 0, Latin1 = 1   (third_party/blink/renderer/modules/storage/cached_storage_area.cc)
// The byte is serialized, so a name that itself starts with \x01 is stored as 01 01 ...
const LATIN1 = 1;
const UTF16 = 0;
function mapKey(origin, name, format = LATIN1) {
  return Buffer.concat([Buffer.from(origin), Buffer.from([0x00, format]), Buffer.from(name, format === LATIN1 ? "latin1" : "utf16le")]);
}
function mapValue(text, format = UTF16) {
  return Buffer.concat([Buffer.from([format]), Buffer.from(text, format === LATIN1 ? "latin1" : "utf16le")]);
}

function padToBlock(buf) {
  if (buf.length >= BLOCK) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK - buf.length)]); // zero padding = type 0
}

test("readRecords returns a single Full record", () => {
  const log = padToBlock(record(1, Buffer.from("hello")));
  const recs = readRecords(log);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].toString(), "hello");
});

test("readRecords reassembles First/Last fragments across blocks", () => {
  const payload = Buffer.alloc(40000);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const first = record(2, payload.subarray(0, BLOCK - 7));
  const last = record(4, payload.subarray(BLOCK - 7));
  const log = Buffer.concat([padToBlock(first), padToBlock(last)]);
  const [rec] = readRecords(log);
  assert.equal(rec.length, payload.length);
  assert.deepEqual([...rec], [...payload]);
});

test("readRecords skips zero padding between blocks", () => {
  const a = record(1, Buffer.from("A"));
  const b = record(1, Buffer.from("B"));
  const log = Buffer.concat([padToBlock(a), padToBlock(b)]);
  assert.deepEqual(readRecords(log).map((r) => r.toString()), ["A", "B"]);
});

test("parseWriteBatch reads key/value entries", () => {
  const batch = buildWriteBatch([
    { key: Buffer.from("k1"), value: Buffer.from("v1") },
    { key: Buffer.from("k2"), value: Buffer.from("value2") },
  ]);
  assert.deepEqual(parseWriteBatch(batch), [
    { seq: 1, op: "put", key: Buffer.from("k1"), value: Buffer.from("v1") },
    { seq: 2, op: "put", key: Buffer.from("k2"), value: Buffer.from("value2") },
  ]);
});

test("parseWriteBatch gives each entry its own sequence number", () => {
  // db/write_batch.cc: the inserter starts at the batch header's sequence and
  // steps once per write, so the n-th entry of a batch is header+n, not header.
  const batch = buildWriteBatch(
    [
      { key: Buffer.from("a"), value: Buffer.from("1") },
      { key: Buffer.from("b"), op: "delete" },
      { key: Buffer.from("c"), value: Buffer.from("3") },
    ],
    41,
  );
  assert.deepEqual(parseWriteBatch(batch).map((e) => e.seq), [41, 42, 43]);
});

test("parseWriteBatch rejects a sequence it cannot count with", () => {
  // The sequence orders writes against .ldb entries; past 2^53 it is no longer
  // an integer in JavaScript, so a batch claiming that is not a batch.
  const batch = buildWriteBatch([{ key: Buffer.from("k"), value: Buffer.from("v") }]);
  batch.writeBigUInt64LE(2n ** 53n, 0);
  assert.deepEqual(parseWriteBatch(batch), []);
});

test("parseWriteBatch rejects the last entry stepping out of the safe range", () => {
  // base alone is not enough: entry i is base + i, so a batch starting just under
  // 2^53 overflows on its third write.
  const batch = buildWriteBatch(
    [
      { key: Buffer.from("a"), value: Buffer.from("1") },
      { key: Buffer.from("b"), value: Buffer.from("2") },
      { key: Buffer.from("c"), value: Buffer.from("3") },
    ],
    BigInt(Number.MAX_SAFE_INTEGER) - 1n,
  );
  assert.deepEqual(parseWriteBatch(batch), []);
});

test("parseWriteBatch reads the tag-first layout that LevelDB writes", () => {
  // spelled out byte by byte: seq(8) + count(4) + tag(1) + varstring(key) + varstring(value)
  const payload = Buffer.from([
    7, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    1, 7, 0x61, 0x2e, 0x63, 0x6f, 0x6d, 0x00, 0x6b, // put, key "a.com\0k"
    4, 0x6f, 0x00, 0x6e, 0x00, // value "on" in UTF-16LE
  ]);
  assert.deepEqual(parseWriteBatch(payload), [
    { seq: 7, op: "put", key: Buffer.from("a.com\u0000k"), value: Buffer.from([0x6f, 0, 0x6e, 0]) },
  ]);
});

test("parseWriteBatch rejects the tag-last layout instead of inventing entries", () => {
  // the shape the old parser assumed (varints swapped, tag at the end) must not
  // produce entries: a misaligned parse yields plausible-looking garbage.
  const payload = Buffer.from([
    7, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    4, 7, 0x61, 0x2e, 0x63, 0x6f, 0x6d, 0x00, 0x6b, 0x6f, 0x00, 0x6e, 0x00, 1,
  ]);
  assert.deepEqual(parseWriteBatch(payload), []);
});

test("parseWriteBatch rejects a payload that does not describe itself exactly", () => {
  const batch = buildWriteBatch([{ key: Buffer.from("a.com\u0000k"), value: Buffer.from("v", "utf16le") }]);
  assert.deepEqual(parseWriteBatch(batch.subarray(0, batch.length - 1)), [], "truncated");
  assert.deepEqual(parseWriteBatch(Buffer.concat([batch, Buffer.from([0x00])])), [], "trailing byte");
});

test("parseWriteBatch rejects an unknown tag byte", () => {
  const batch = buildWriteBatch([{ key: Buffer.from("k"), value: Buffer.from("v") }]);
  batch[12] = 9; // not kTypeValue(1) / kTypeDeletion(0)
  assert.deepEqual(parseWriteBatch(batch), []);
});

test("parseWriteBatch reads an empty batch as no entries", () => {
  assert.deepEqual(parseWriteBatch(buildWriteBatch([])), []);
});

test("parseWriteBatch handles multi-byte varint lengths", () => {
  const big = Buffer.alloc(200, 7);
  const batch = buildWriteBatch([{ key: Buffer.from("x"), value: big }]);
  const [e] = parseWriteBatch(batch);
  assert.equal(e.value.length, 200);
});

test("decodeEntry strips the format byte and decodes a UTF-16 name", () => {
  const e = decodeEntry(mapKey("https://a.com", "café☕", UTF16), mapValue("whatever", UTF16));
  assert.equal(e.key, "café☕");
  assert.equal(e.size, 10 + 16); // 5 UTF-16 code units in the name, 8 in the value
});

test("decodeEntry decodes a Latin-1 name", () => {
  const e = decodeEntry(mapKey("https://a.com", "base_URL"), mapValue("red", LATIN1));
  assert.deepEqual(e, { origin: "https://a.com", key: "base_URL", size: 8 + 3 });
});

test("decodeEntry keeps a format byte that is part of the name", () => {
  // an item name may legitimately begin with U+0001; only ONE byte is the tag
  const e = decodeEntry(mapKey("https://a.com", "\u0001odd"), mapValue("x", LATIN1));
  assert.equal(e.key, "\u0001odd");
  assert.equal(e.size, 4 + 1);
});

// Nothing prints a value and sizes come from its byte length, so the reader must
// measure the payload rather than decode it.
test("decodeEntry measures the value instead of decoding it", () => {
  const e = decodeEntry(mapKey("https://a.com", "color", UTF16), mapValue("café☕", UTF16));
  assert.deepEqual(e, { origin: "https://a.com", key: "color", size: 10 + 10 });
  assert.ok(!("value" in e), "the value text must never reach the entry");
});

test("decodeEntry rejects a value with an unknown format byte", () => {
  const value = Buffer.concat([Buffer.from([0x07]), Buffer.from("guess")]);
  assert.equal(decodeEntry(mapKey("https://a.com", "k"), value), null);
});

test("decodeEntry rejects an odd-length UTF-16 value", () => {
  const value = Buffer.concat([Buffer.from([UTF16]), Buffer.from([0x61, 0x00, 0x62])]);
  assert.equal(decodeEntry(mapKey("https://a.com", "k"), value), null);
});

test("decodeEntry rejects an unknown format byte instead of guessing", () => {
  const key = Buffer.concat([Buffer.from("https://a.com"), Buffer.from([0x00, 0x02]), Buffer.from("k")]);
  assert.equal(decodeEntry(key, mapValue("v")), null);
});

test("decodeEntry rejects an odd-length UTF-16 payload", () => {
  const key = Buffer.concat([Buffer.from("https://a.com"), Buffer.from([0x00, UTF16]), Buffer.from([0x6b, 0x00, 0x6b])]);
  assert.equal(decodeEntry(key, mapValue("v")), null);
});

test("decodeEntry returns null for metadata rows", () => {
  assert.equal(decodeEntry(Buffer.from("META:https://a.com"), mapValue("{}")), null);
  assert.equal(decodeEntry(Buffer.from("METAACCESS:https://a.com"), mapValue("{}")), null);
});

// ---- test-side encoders for a leveldb table (SSTable), mirroring table/format.cc
// Only what the merge needs: one uncompressed data block, an empty meta index
// (a table with no filter) and an index that points at that block.
const TABLE_MAGIC = 0xdb4775248b80fb57n;
const fixed32 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]);

// The eight bytes behind a user key are (sequence << 8) | type, where 0 is a
// deletion and 1 is a value (db/format.h).
function internalKey(user, seq, type) {
  const buf = Buffer.alloc(user.length + 8);
  user.copy(buf);
  buf.writeBigUInt64LE((BigInt(seq) << 8n) | BigInt(type), user.length);
  return buf;
}

// Every entry here starts its own restart point (shared = 0), which is legal and
// the simplest thing a fixture can do.
function blockOf(entries) {
  let at = 0;
  const parts = [];
  const restarts = [];
  for (const { key, value } of entries) {
    restarts.push(at);
    const part = Buffer.concat([varint(0), varint(key.length), varint(value.length), key, value]);
    parts.push(part);
    at += part.length;
  }
  return Buffer.concat([...parts, ...restarts.map(fixed32), fixed32(restarts.length)]);
}

// A block on disk: contents, one compression-type byte, then the four crc bytes.
const blockFile = (block) => Buffer.concat([block, Buffer.from([0]), fixed32(0)]);

function ldb(entries) {
  const data = blockOf(entries);
  const meta = Buffer.concat([fixed32(0), fixed32(1)]); // empty block: one restart at 0
  const index = blockOf([
    { key: Buffer.from("z"), value: Buffer.concat([varint(0), varint(data.length)]) },
  ]);
  const footer = Buffer.concat([
    varint(data.length + 5), varint(meta.length),
    varint(data.length + meta.length + 10), varint(index.length),
  ]);
  const magic = Buffer.alloc(8);
  magic.writeBigUInt64LE(TABLE_MAGIC);
  return Buffer.concat([blockFile(data), blockFile(meta), blockFile(index), footer, Buffer.alloc(40 - footer.length), magic]);
}

const logOf = (writes, seq) => padToBlock(record(1, buildWriteBatch(writes, seq)));

// The reader answers with the entries it merged and the tables it could not read;
// tests about data ask for `.entries`, tests about coverage ask for `.skipped`.
const store = (files) => readLocalStorage({ listFiles: () => Object.keys(files), readFile: (name) => files[name] });

test("readLocalStorage decodes Full-record entries from a .log file", () => {
  const batch = buildWriteBatch([
    { key: mapKey("https://a.com", "color"), value: mapValue("red") },
    { key: mapKey("https://b.com", "theme"), value: mapValue("dark") },
  ]);
  const { entries } = store({ "000005.log": padToBlock(record(1, batch)) });
  assert.deepEqual(
    entries.map((e) => `${e.origin}|${e.key}|${e.size}`),
    ["https://a.com|color|11", "https://b.com|theme|13"],
  );
});

test("readLocalStorage prints no format byte in the key (live Edge store shape)", () => {
  // exactly what was measured in a real profile: Latin-1 names, UTF-16 values
  const batch = buildWriteBatch([
    { key: mapKey("_chrome-extension://abcdefghijklmnopqrstuvwxyz", "base_URL"), value: mapValue("https://example.com") },
  ]);
  const [entry] = store({ "000017.log": padToBlock(record(1, batch)) }).entries;
  assert.equal(entry.key, "base_URL");
  assert.ok(!/[\u0000-\u001f]/.test(`${entry.origin}${entry.key}`), "no control byte may reach the output");
});

test("readLocalStorage skips metadata rows", () => {
  const batch = buildWriteBatch([
    { key: Buffer.from("META:https://a.com"), value: mapValue("{}") },
    { key: Buffer.from("METAACCESS:https://a.com"), value: mapValue("{}") },
    { key: mapKey("https://a.com", "k"), value: mapValue("v") },
  ]);
  const entries = store({ "x.log": padToBlock(record(1, batch)) }).entries;
  assert.deepEqual(entries.map((e) => e.key), ["k"]);
});

test("readLocalStorage honours delete records", () => {
  const key = mapKey("https://a.com", "k");
  const files = {
    "000003.log": padToBlock(record(1, buildWriteBatch([{ key, value: mapValue("gone") }, { key, op: "delete" }]))),
  };
  assert.deepEqual(store(files).entries, []);
});

test("readLocalStorage merges and last-write-wins across multiple logs", () => {
  const key = mapKey("https://a.com", "k");
  const files = {
    "000003.log": padToBlock(record(1, buildWriteBatch([{ key, value: mapValue("old") }]))),
    // longer on purpose: the size is what shows the second log won, since no text survives
    "000007.log": padToBlock(record(1, buildWriteBatch([{ key, value: mapValue("newer") }]))),
  };
  assert.deepEqual(store(files).entries, [{ origin: "https://a.com", key: "k", size: 1 + 10 }]);
});

test("readLocalStorage computes size from key + value bytes, format tags excluded", () => {
  const batch = buildWriteBatch([{ key: mapKey("https://a.com", "k"), value: mapValue("v") }]);
  const [out] = store({ "a.log": padToBlock(record(1, batch)) }).entries;
  assert.equal(out.size, 1 + 2); // Latin-1 "k" (1 B) + UTF-16 "v" (2 B); the two tag bytes are not data
});

test("readLocalStorage drops a row whose format byte is unknown", () => {
  const key = Buffer.concat([Buffer.from("https://a.com"), Buffer.from([0x00, 0x7f]), Buffer.from("k")]);
  const batch = buildWriteBatch([{ key, value: mapValue("v") }, { key: mapKey("https://a.com", "kept"), value: mapValue("v") }]);
  const entries = store({ "a.log": padToBlock(record(1, batch)) }).entries;
  assert.deepEqual(entries.map((e) => e.key), ["kept"]);
});

test("readLocalStorage reads a store that holds only tables", () => {
  const { entries, skipped } = store({
    "000012.ldb": ldb([
      { key: internalKey(mapKey("https://a.com", "k"), 6, 1), value: mapValue("v") },
    ]),
  });
  assert.deepEqual(entries, [{ origin: "https://a.com", key: "k", size: 1 + 2 }]);
  assert.deepEqual(skipped, []);
});

// Compaction rewrites most of the store into tables, so a Chromium profile's live
// data is split across *.ldb and the *.log tail. LevelDB resolves a key by its
// sequence number (db/db_impl.cc DoCompactionWork), and that has to be what the
// merge orders by — file names and file order mean nothing here.
test("readLocalStorage lets the higher sequence win across a table and the log", () => {
  const key = mapKey("https://a.com", "color");
  // the table comes first in file order and holds the newer write: only ordering
  // by sequence can make it win
  const { entries } = store({
    "000012.ldb": ldb([{ key: internalKey(key, 40, 1), value: mapValue("from the table") }]),
    "000017.log": logOf([{ key, value: mapValue("old") }], 5),
  });
  assert.deepEqual(entries, [{ origin: "https://a.com", key: "color", size: 5 + 28 }]);
});

test("readLocalStorage lets a newer WAL write win over a table", () => {
  const key = mapKey("https://a.com", "color");
  const { entries } = store({
    "000012.ldb": ldb([{ key: internalKey(key, 10, 1), value: mapValue("stale") }]),
    "000017.log": logOf([{ key, value: mapValue("newer") }], 20),
  });
  assert.deepEqual(entries, [{ origin: "https://a.com", key: "color", size: 5 + 10 }]);
});

test("a table tombstone hides an older WAL write", () => {
  const key = mapKey("https://a.com", "color");
  const { entries } = store({
    "000012.ldb": ldb([{ key: internalKey(key, 40, 0), value: Buffer.alloc(0) }]),
    "000017.log": logOf([{ key, value: mapValue("written before the compaction") }], 30),
  });
  assert.deepEqual(entries, []);
});

test("a WAL delete hides an older table write", () => {
  const key = mapKey("https://a.com", "color");
  const { entries } = store({
    "000012.ldb": ldb([{ key: internalKey(key, 10, 1), value: mapValue("v") }]),
    "000017.log": logOf([{ key, op: "delete" }], 50),
  });
  assert.deepEqual(entries, []);
});

test("readLocalStorage drops the metadata rows a table carries", () => {
  // measured in a real profile: every table holds META: / METAACCESS: / VERSION
  // rows next to the item rows, and none of them is user data
  const { entries } = store({
    "000012.ldb": ldb([
      { key: internalKey(Buffer.from("META:https://a.com"), 1, 1), value: mapValue("{}") },
      { key: internalKey(Buffer.from("METAACCESS:https://a.com"), 2, 1), value: mapValue("{}") },
      { key: internalKey(Buffer.from("VERSION"), 3, 1), value: mapValue("{}") },
      { key: internalKey(mapKey("https://a.com", "k"), 4, 1), value: mapValue("v") },
    ]),
  });
  assert.deepEqual(entries.map((e) => e.key), ["k"]);
});

// A table is one compaction's worth of history. Losing one makes the totals small,
// so it has to be reported — but it must not take the readable rest of the store
// with it, which is what a locked or half-written table would otherwise do.
test("readLocalStorage reports a table it cannot parse instead of failing", () => {
  const { entries, skipped } = store({
    "000012.ldb": Buffer.from("this is not a table"),
    "000017.log": logOf([{ key: mapKey("https://a.com", "k"), value: mapValue("v") }], 1),
  });
  assert.deepEqual(entries.map((e) => e.key), ["k"]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, "000012.ldb");
  assert.match(skipped[0].reason, /not an sstable/);
});

test("readLocalStorage reports a table the browser will not let it open", () => {
  const files = { "000017.log": logOf([{ key: mapKey("https://a.com", "k"), value: mapValue("v") }], 1) };
  const { entries, skipped } = readLocalStorage({
    listFiles: () => ["000012.ldb", "000017.log"],
    readFile: (name) => {
      if (name.endsWith(".ldb")) throw new Error("EBUSY: resource busy or locked");
      return files[name];
    },
  });
  assert.deepEqual(entries.map((e) => e.key), ["k"]);
  assert.deepEqual(skipped.map((s) => s.name), ["000012.ldb"]);
  assert.match(skipped[0].reason, /locked/);
});

test("readLocalStorage refuses to order a table whose entry type it does not know", () => {
  const key = mapKey("https://a.com", "k");
  const { entries, skipped } = store({
    "000012.ldb": ldb([
      // a row this reader could use, sitting before the one it cannot: a table
      // whose history cannot be ordered contributes nothing at all, because the
      // unknown row might have been the newest write for any key in it
      { key: internalKey(mapKey("https://a.com", "kept"), 9, 1), value: mapValue("v") },
      { key: internalKey(key, 10, 4), value: mapValue("v") },
    ]),
    "000017.log": logOf([{ key, value: mapValue("from the log") }], 5),
  });
  assert.deepEqual(entries.map((e) => e.key), ["k"]);
  assert.match(skipped[0].reason, /type 4/);
});

test("a log the reader cannot open still fails the command", () => {
  // the WAL tail is where the writes the browser has not compacted live; a store
  // whose log cannot be opened is not a partial result, it is an unreadable store
  assert.throws(
    () =>
      readLocalStorage({
        listFiles: () => ["000017.log"],
        readFile: () => {
          throw new Error("EBUSY: resource busy or locked");
        },
      }),
    /locked/,
  );
});

const LS = [
  { origin: "https://a.com", key: "x", size: 3 },
  { origin: "https://a.com", key: "y", size: 4 },
  { origin: "https://sub.b.com", key: "z", size: 3 },
];

test("filterLocalStorage matches by origin host substring", () => {
  assert.deepEqual(filterLocalStorage(LS, { domain: "a.com" }).map((e) => e.key), ["x", "y"]);
  assert.deepEqual(filterLocalStorage(LS, { domain: "b.com" }).map((e) => e.origin), ["https://sub.b.com"]);
});

test("filterLocalStorage with no domain returns all", () => {
  assert.equal(filterLocalStorage(LS, {}).length, 3);
});

test("groupStorage aggregates count + size per origin, sorted desc", () => {
  assert.deepEqual(groupStorage(LS), [
    { origin: "https://a.com", count: 2, size: 7 },
    { origin: "https://sub.b.com", count: 1, size: 3 },
  ]);
});
