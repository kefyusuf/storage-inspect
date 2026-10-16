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

function buildWriteBatch(entries) {
  const parts = [Buffer.alloc(8), Buffer.alloc(4)]; // seq(8) + count(4)
  parts[1].writeUInt32LE(entries.length, 0);
  for (const { key, value } of entries) {
    parts.push(varint(value.length), varint(key.length), key, value);
  }
  return Buffer.concat(parts);
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
    { key: Buffer.from("k1"), value: Buffer.from("v1") },
    { key: Buffer.from("k2"), value: Buffer.from("value2") },
  ]);
});

test("parseWriteBatch handles multi-byte varint lengths", () => {
  const big = Buffer.alloc(200, 7);
  const batch = buildWriteBatch([{ key: Buffer.from("x"), value: big }]);
  const [e] = parseWriteBatch(batch);
  assert.equal(e.value.length, 200);
});

test("decodeEntry splits origin/name and decodes UTF-16 value", () => {
  const key = Buffer.concat([Buffer.from("https://a.com"), Buffer.from([0x00]), Buffer.from("color")]);
  const value = Buffer.from("café☕", "utf16le"); // non-ascii to prove UTF-16 decoding
  const e = decodeEntry(key, value);
  assert.deepEqual(e, { origin: "https://a.com", key: "color", value: "café☕" });
});

test("readLocalStorage decodes Full-record entries from a .log file", () => {
  const mk = (origin, key, val) => ({
    key: Buffer.concat([Buffer.from(origin), Buffer.from([0x00]), Buffer.from(key)]),
    value: Buffer.from(val, "utf16le"),
  });
  const batch = buildWriteBatch([
    mk("https://a.com", "color", "red"),
    mk("https://b.com", "theme", "dark"),
  ]);
  const log = padToBlock(record(1, batch));
  const files = { "000005.log": log };
  const entries = readLocalStorage({
    listFiles: () => Object.keys(files),
    readFile: (name) => files[name],
  });
  assert.deepEqual(
    entries.map((e) => `${e.origin}|${e.key}|${e.value}`),
    ["https://a.com|color|red", "https://b.com|theme|dark"],
  );
});

test("readLocalStorage skips META: records", () => {
  const batch = buildWriteBatch([
    { key: Buffer.from("META:https://a.com"), value: Buffer.from("{}", "utf16le") },
    { key: Buffer.concat([Buffer.from("https://a.com"), Buffer.from([0x00]), Buffer.from("k")]), value: Buffer.from("v", "utf16le") },
  ]);
  const entries = readLocalStorage({ listFiles: () => ["x.log"], readFile: () => padToBlock(record(1, batch)) });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, "k");
});

test("readLocalStorage merges and last-write-wins across multiple logs", () => {
  const mk = (v) => ({ key: Buffer.concat([Buffer.from("https://a.com"), Buffer.from([0x00]), Buffer.from("k")]), value: Buffer.from(v, "utf16le") });
  const files = {
    "000003.log": padToBlock(record(1, buildWriteBatch([mk("old")]))),
    "000007.log": padToBlock(record(1, buildWriteBatch([mk("new")]))),
  };
  const entries = readLocalStorage({ listFiles: () => Object.keys(files), readFile: (n) => files[n] });
  assert.deepEqual(entries, [{ origin: "https://a.com", key: "k", value: "new", size: "k".length + Buffer.byteLength("new", "utf16le") }]);
});

test("readLocalStorage computes size from key + value bytes", () => {
  const e = { origin: "https://a.com", key: "k", value: "v" };
  const batch = buildWriteBatch([
    { key: Buffer.concat([Buffer.from("https://a.com"), Buffer.from([0x00]), Buffer.from("k")]), value: Buffer.from("v", "utf16le") },
  ]);
  const [out] = readLocalStorage({ listFiles: () => ["a.log"], readFile: () => padToBlock(record(1, batch)) });
  assert.equal(out.size, 1 + 2); // key "k" (1) + utf16 "v" (2 bytes)
});

const LS = [
  { origin: "https://a.com", key: "x", value: "1", size: 3 },
  { origin: "https://a.com", key: "y", value: "22", size: 4 },
  { origin: "https://sub.b.com", key: "z", value: "3", size: 3 },
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
