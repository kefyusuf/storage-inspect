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

test("readLocalStorage decodes Full-record entries from a .log file", () => {
  const batch = buildWriteBatch([
    { key: mapKey("https://a.com", "color"), value: mapValue("red") },
    { key: mapKey("https://b.com", "theme"), value: mapValue("dark") },
  ]);
  const log = padToBlock(record(1, batch));
  const files = { "000005.log": log };
  const entries = readLocalStorage({
    listFiles: () => Object.keys(files),
    readFile: (name) => files[name],
  });
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
  const [entry] = readLocalStorage({ listFiles: () => ["000017.log"], readFile: () => padToBlock(record(1, batch)) });
  assert.equal(entry.key, "base_URL");
  assert.ok(!/[\u0000-\u001f]/.test(`${entry.origin}${entry.key}`), "no control byte may reach the output");
});

test("readLocalStorage skips metadata rows", () => {
  const batch = buildWriteBatch([
    { key: Buffer.from("META:https://a.com"), value: mapValue("{}") },
    { key: Buffer.from("METAACCESS:https://a.com"), value: mapValue("{}") },
    { key: mapKey("https://a.com", "k"), value: mapValue("v") },
  ]);
  const entries = readLocalStorage({ listFiles: () => ["x.log"], readFile: () => padToBlock(record(1, batch)) });
  assert.deepEqual(entries.map((e) => e.key), ["k"]);
});

test("readLocalStorage honours delete records", () => {
  const key = mapKey("https://a.com", "k");
  const files = {
    "000003.log": padToBlock(record(1, buildWriteBatch([{ key, value: mapValue("gone") }, { key, op: "delete" }]))),
  };
  assert.deepEqual(readLocalStorage({ listFiles: () => Object.keys(files), readFile: (n) => files[n] }), []);
});

test("readLocalStorage merges and last-write-wins across multiple logs", () => {
  const key = mapKey("https://a.com", "k");
  const files = {
    "000003.log": padToBlock(record(1, buildWriteBatch([{ key, value: mapValue("old") }]))),
    // longer on purpose: the size is what shows the second log won, since no text survives
    "000007.log": padToBlock(record(1, buildWriteBatch([{ key, value: mapValue("newer") }]))),
  };
  const entries = readLocalStorage({ listFiles: () => Object.keys(files), readFile: (n) => files[n] });
  assert.deepEqual(entries, [{ origin: "https://a.com", key: "k", size: 1 + 10 }]);
});

test("readLocalStorage computes size from key + value bytes, format tags excluded", () => {
  const batch = buildWriteBatch([{ key: mapKey("https://a.com", "k"), value: mapValue("v") }]);
  const [out] = readLocalStorage({ listFiles: () => ["a.log"], readFile: () => padToBlock(record(1, batch)) });
  assert.equal(out.size, 1 + 2); // Latin-1 "k" (1 B) + UTF-16 "v" (2 B); the two tag bytes are not data
});

test("readLocalStorage drops a row whose format byte is unknown", () => {
  const key = Buffer.concat([Buffer.from("https://a.com"), Buffer.from([0x00, 0x7f]), Buffer.from("k")]);
  const batch = buildWriteBatch([{ key, value: mapValue("v") }, { key: mapKey("https://a.com", "kept"), value: mapValue("v") }]);
  const entries = readLocalStorage({ listFiles: () => ["a.log"], readFile: () => padToBlock(record(1, batch)) });
  assert.deepEqual(entries.map((e) => e.key), ["kept"]);
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
