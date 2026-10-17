import { test } from "node:test";
import assert from "node:assert/strict";
import { readSstEntries } from "../src/sstable.js";

// Everything below is written out byte by byte from leveldb's table format
// (table/format.{h,cc}, table/block.cc, table/table_builder.cc), so the reader
// is tested against the format and not against a builder that shares its bugs.
const MAGIC = 0xdb4775248b80fb57n;

function varint(n) {
  const out = [];
  for (;;) {
    const b = n % 128;
    n = Math.floor(n / 128);
    out.push(n > 0 ? b + 128 : b);
    if (n === 0) break;
  }
  return Buffer.from(out);
}

const fixed32 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]);

// The table magic as it sits at the very end of the file: low half first.
const magicBytes = (m = MAGIC) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(m);
  return b;
};

// An entry in a block: shared prefix length, new key bytes, value length, then
// the bytes themselves. `shared: 0` also marks a restart point.
function entryOf({ shared = 0, key, value = Buffer.alloc(0) }) {
  const k = Buffer.from(key);
  return Buffer.concat([varint(shared), varint(k.length), varint(value.length), k, value]);
}

function blockOf(entries) {
  let at = 0;
  const parts = [];
  const restarts = [];
  for (const e of entries) {
    // `shared` is omitted for a restart point, so it has to default before the
    // comparison or a block ends up claiming it has no restart points at all.
    if ((e.shared ?? 0) === 0) restarts.push(at);
    const part = entryOf(e);
    parts.push(part);
    at += part.length;
  }
  const tail = Buffer.concat([
    ...restarts.map(fixed32),
    fixed32(restarts.length),
  ]);
  return Buffer.concat([...parts, tail]);
}

// An empty block is what leveldb writes for the meta index of a table with no
// filter: one restart point at offset 0, so eight bytes.
const emptyBlock = Buffer.concat([fixed32(0), fixed32(1)]);

// A Snappy stream made of literals only: legal, and the point is to inflate a
// block without an encoder in the test suite.
function snappyLiterals(buf) {
  const parts = [varint(buf.length)];
  for (let at = 0; at < buf.length; at += 60) {
    const size = Math.min(60, buf.length - at);
    parts.push(Buffer.from([((size - 1) << 2) & 0xff]), buf.subarray(at, at + size));
  }
  return Buffer.concat(parts);
}

const handleOf = (offset, size) => Buffer.concat([varint(offset), varint(size)]);

function makeTable({ entries, rawBlocks, dataSnappy = false, dataType = dataSnappy ? 1 : 0, indexSnappy = false, magic = MAGIC }) {
  const blocks = rawBlocks ?? (Array.isArray(entries[0]) ? entries : [entries]).map(blockOf);
  const parts = [];
  const handles = [];
  let offset = 0;
  for (const block of blocks) {
    const body = dataSnappy ? snappyLiterals(block) : block;
    // block contents, then the type byte, then the four crc bytes
    parts.push(body, Buffer.from([dataType]), fixed32(0xc0ffee));
    handles.push(handleOf(offset, body.length));
    offset += body.length + 5;
  }

  parts.push(emptyBlock, Buffer.from([0]), fixed32(0));
  const metaHandle = handleOf(offset, emptyBlock.length);
  offset += emptyBlock.length + 5;

  // A real index entry key is the largest internal key of the block it points
  // at; this reader only follows the handle, so the fixture keeps them short.
  const indexEntries = handles.map((value, i) => ({ key: Buffer.from(`k${i}`), value }));
  const indexBlock = blockOf(indexEntries);
  const indexBody = indexSnappy ? snappyLiterals(indexBlock) : indexBlock;
  parts.push(indexBody, Buffer.from([indexSnappy ? 1 : 0]), fixed32(0));
  const indexHandle = handleOf(offset, indexBody.length);

  const footerBody = Buffer.concat([metaHandle, indexHandle]);
  const footer = Buffer.concat([
    footerBody,
    Buffer.alloc(2 * 20 - footerBody.length),
    magicBytes(magic),
  ]);

  return Buffer.concat([...parts, footer]);
}

// The eight bytes after a user key hold (sequence << 8) | type.
const internalKey = (user, seq, type) => {
  const b = Buffer.alloc(user.length + 8);
  Buffer.from(user).copy(b);
  b.writeBigUInt64LE((BigInt(seq) << 8n) | BigInt(type), user.length);
  return b;
};

test("reads entries out of a hand-built table", () => {
  const out = readSstEntries(
    "handmade.ldb",
    makeTable({
      entries: [
        { key: internalKey("https://a.com\x00\x01token", 7, 1), value: Buffer.alloc(30, 0x61) },
        { key: internalKey("https://b.com\x00\x01cart", 8, 1), value: Buffer.alloc(4, 0x62) },
      ],
    }),
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.userKey.toString("latin1")), [
    "https://a.com\x00\x01token",
    "https://b.com\x00\x01cart",
  ]);
  assert.deepEqual(out.map((e) => e.seq), [7, 8]);
  assert.deepEqual(out.map((e) => e.type), [1, 1]);
  assert.deepEqual(out.map((e) => e.value.length), [30, 4]);
});

test("the internal key splits into user key, sequence and type", () => {
  const [entry] = readSstEntries(
    "tombstone.ldb",
    makeTable({ entries: [{ key: internalKey("gone", 99, 0), value: Buffer.alloc(0) }] }),
  );
  assert.equal(entry.userKey.toString("latin1"), "gone");
  assert.equal(entry.seq, 99);
  assert.equal(entry.type, 0, "kTypeDeletion must survive, the merge needs it");
});

test("keys sharing a prefix are rebuilt from the restart points", () => {
  const first = internalKey("https://shared.example.com\x00\x01alpha", 1, 1);
  const second = internalKey("https://shared.example.com\x00\x01beta", 2, 1);
  const third = internalKey("https://other.example.com\x00\x01alpha", 3, 1);
  const out = readSstEntries(
    "prefix.ldb",
    makeTable({
      entries: [
        { key: first, value: Buffer.alloc(1) },
        // The two keys share the whole storage key plus the 0x00 separator and
        // the format byte — 26 + 2 — and differ from the item name on. Their
        // 8-byte internal suffixes differ (seq 1 vs 2), so nothing past that is
        // shared either.
        {
          shared: 28,
          key: second.subarray(28),
          value: Buffer.alloc(1),
        },
        { key: third, value: Buffer.alloc(1) },
      ],
    }),
  );
  assert.deepEqual(
    out.map((e) => e.userKey.toString("latin1")),
    [
      "https://shared.example.com\x00\x01alpha",
      "https://shared.example.com\x00\x01beta",
      "https://other.example.com\x00\x01alpha",
    ],
  );
  // the suffix of a rebuilt key belongs to that entry, not to the one it
  // borrowed its prefix from
  assert.deepEqual(out.map((e) => e.seq), [1, 2, 3]);
});

test("several data blocks are read in handle order", () => {
  const out = readSstEntries(
    "two-blocks.ldb",
    makeTable({
      entries: [
        [{ key: internalKey("a", 1, 1), value: Buffer.alloc(2) }],
        [{ key: internalKey("b", 2, 1), value: Buffer.alloc(3) }],
      ],
    }),
  );
  assert.deepEqual(out.map((e) => e.userKey.toString()), ["a", "b"]);
});

test("a Snappy data block is inflated before it is parsed", () => {
  const [entry] = readSstEntries(
    "snappy.ldb",
    makeTable({
      dataSnappy: true,
      entries: [{ key: internalKey("compact", 3, 1), value: Buffer.alloc(100, 0x7a) }],
    }),
  );
  assert.equal(entry.userKey.toString("latin1"), "compact");
  assert.equal(entry.value.length, 100);
});

test("a Snappy index block is inflated too", () => {
  const out = readSstEntries(
    "snappy-index.ldb",
    makeTable({
      indexSnappy: true,
      entries: [{ key: internalKey("indexed", 4, 1), value: Buffer.alloc(5) }],
    }),
  );
  assert.equal(out[0].userKey.toString("latin1"), "indexed");
});

test("a file that is not an sstable says so, naming the file it came from", () => {
  const bytes = makeTable(
    { entries: [{ key: internalKey("a", 1, 1), value: Buffer.alloc(1) }], magic: 0x00000002_00000001n },
  );
  assert.throws(() => readSstEntries("wrong.ldb", bytes), /not an sstable: wrong\.ldb\b.*magic/i);
});

test("a table shorter than a footer is refused", () => {
  assert.throws(() => readSstEntries("tiny.ldb", Buffer.alloc(20, 0x61)), /shorter than a 48-byte footer/);
});

test("a handle pointing past the end of the file is refused", () => {
  // Cut the table short and the footer no longer lands on the last 48 bytes:
  // that path is really the magic check, so instead the footer is kept whole
  // and its index size is enlarged to claim bytes the table does not have.
  // Every handle here is a single-byte varint, so byte 3 of the footer is it.
  const bytes = makeTable({ entries: [{ key: internalKey("a", 1, 1), value: Buffer.alloc(1) }] });
  const patched = Buffer.from(bytes);
  patched[patched.length - 48 + 3] = 0xff;
  assert.throws(() => readSstEntries("over-large-handle.ldb", patched), /runs past/);
});

test("an entry whose lengths do not describe the block is refused", () => {
  // header promises a 400-byte key delta and a 4-byte value, the block holds two
  const broken = Buffer.concat([varint(0), varint(400), varint(4), Buffer.from("ab"), fixed32(0), fixed32(1)]);
  assert.throws(() => readSstEntries("broken.ldb", makeTable({ rawBlocks: [broken] })), /wants 400 key bytes/);
});

test("an entry that shares more than the previous key has is refused", () => {
  // Every length here fits inside the block; only the shared prefix is a lie. A
  // reader that clamps instead of refusing silently returns the wrong key. The
  // keys carry a plausible 8-byte internal suffix so nothing else trips first.
  const broken = Buffer.concat([
    varint(0), varint(10), varint(1), Buffer.from("abcdefghij"), Buffer.from([0x01]),
    varint(50), varint(2), varint(1), Buffer.from("cd"), Buffer.from([0x02]),
    fixed32(0), fixed32(1),
  ]);
  assert.throws(() => readSstEntries("over-shared.ldb", makeTable({ rawBlocks: [broken] })), /after 50 shared/);
});

test("a zstd block says which compression it cannot inflate", () => {
  const bytes = makeTable({
    rawBlocks: [blockOf([{ key: internalKey("a", 1, 1), value: Buffer.alloc(1) }])],
    dataType: 2,
  });
  assert.throws(() => readSstEntries("zstd.ldb", bytes), /zstd/);
});

test("a footer varint that never ends is refused", () => {
  // Every handle byte keeps its continuation bit set. A reader that kept
  // summing would run past the footer and trust a length from nowhere.
  const bytes = Buffer.concat([Buffer.alloc(40, 0xff), magicBytes()]);
  assert.throws(() => readSstEntries("runaway.ldb", bytes), /bounded varint/);
});

test("a restart array that cannot fit in the block is refused", () => {
  const broken = Buffer.concat([Buffer.from([0x00, 0x02, 0x00]), Buffer.from("ab"), fixed32(0), fixed32(1000)]);
  assert.throws(() => readSstEntries("bad-restarts.ldb", makeTable({ rawBlocks: [broken] })), /restart/);
});
