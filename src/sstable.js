import { readFileSync } from "node:fs";
import { snappyUncompress } from "./snappy.js";

// leveldb's SSTable format, the thing a *.ldb file is. Layout as written by
// table/table_builder.cc and read back by table/format.cc and table/block.cc:
//
//   data block* , meta index block, index block, footer
//   footer = metaindex handle, index handle, zero padding to 40 bytes, magic uint64
//   block  = contents, type byte, crc uint32            (the crc is not verified here)
//   index entry value = varint offset, varint size      (a handle onto a data block)
//   block contents = (shared, non_shared, value_len, key delta, value)* ,
//                    restart offsets as uint32, restart count as uint32
//
// Values are handed back as they sit in the block: a Buffer nobody decodes.
const MAGIC = 0xdb4775248b80fb57n;
const FOOTER_BYTES = 48;
const TRAILER_BYTES = 5;
const TYPE_NONE = 0;
const TYPE_SNAPPY = 1;
const TYPE_ZSTD = 2;
const KEY_SUFFIX_BYTES = 8;

function readVarint(buf, at, what) {
  let value = 0;
  let scale = 1;
  for (let i = at; i < buf.length; i++, scale *= 128) {
    const byte = buf[i];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [value, i + 1];
    if (scale > 2 ** 24) break;
  }
  throw new Error(`${what} is not a bounded varint`);
}

// Yields { key, value } for every entry in one block, rebuilding the
// prefix-compressed keys as it goes. Nothing here trusts a length it reads: each
// one has to fit inside the block body, and an entry that does not is an error,
// not a byte to guess at.
function* iterateBlock(body) {
  if (body.length < 4) throw new Error("block is too short to hold a restart count");
  const restarts = body.readUInt32LE(body.length - 4);
  const bodyEnd = body.length - (restarts + 1) * 4;
  if (restarts === 0 || bodyEnd < 0) {
    throw new Error(`restart array of ${restarts} points cannot fit a ${body.length}-byte block`);
  }
  let key = Buffer.alloc(0);
  let at = 0;
  while (at < bodyEnd) {
    const [shared, afterShared] = readVarint(body, at, "shared key length");
    const [nonShared, afterNonShared] = readVarint(body, afterShared, "new key length");
    const [valueSize, afterValueSize] = readVarint(body, afterNonShared, "value length");
    const keyEnd = afterValueSize + nonShared;
    const valueEnd = keyEnd + valueSize;
    if (shared > key.length || valueEnd > bodyEnd) {
      throw new Error(
        `block entry wants ${nonShared} key bytes after ${shared} shared and ${valueSize} value ` +
          `bytes, the body has ${bodyEnd - afterValueSize}`,
      );
    }
    key =
      shared === 0
        ? body.subarray(afterValueSize, keyEnd)
        : Buffer.concat([key.subarray(0, shared), body.subarray(afterValueSize, keyEnd)]);
    yield { key, value: body.subarray(keyEnd, valueEnd) };
    at = valueEnd;
  }
}

// The eight bytes after a user key are (sequence << 8) | value type, where
// 0 is a deletion and 1 is a value; both are needed to merge a table against
// the write-ahead log later.
function splitInternalKey(key) {
  if (key.length < KEY_SUFFIX_BYTES) {
    throw new Error(`internal key of ${key.length} bytes is shorter than its ${KEY_SUFFIX_BYTES}-byte suffix`);
  }
  const suffix = key.readBigUInt64LE(key.length - KEY_SUFFIX_BYTES);
  return {
    userKey: key.subarray(0, key.length - KEY_SUFFIX_BYTES),
    seq: Number(suffix >> 8n),
    type: Number(suffix & 0xffn),
  };
}

export function readSstEntries(path) {
  const file = readFileSync(path);
  if (file.length < FOOTER_BYTES) {
    throw new Error(`not an sstable: ${path} is ${file.length} bytes, shorter than a ${FOOTER_BYTES}-byte footer`);
  }
  const footer = file.subarray(file.length - FOOTER_BYTES);
  const magic = (BigInt(footer.readUInt32LE(FOOTER_BYTES - 4)) << 32n) | BigInt(footer.readUInt32LE(FOOTER_BYTES - 8));
  if (magic !== MAGIC) {
    throw new Error(`not an sstable: ${path} ends with magic 0x${magic.toString(16)}, not leveldb's table magic`);
  }

  const inflate = (offset, size, what) => {
    if (offset + size + TRAILER_BYTES > file.length) {
      throw new Error(`truncated table: the ${what} block at ${offset}+${size} runs past ${file.length} bytes of ${path}`);
    }
    const type = file[offset + size];
    const body = file.subarray(offset, offset + size);
    if (type === TYPE_SNAPPY) return snappyUncompress(body);
    if (type === TYPE_NONE) return body;
    if (type === TYPE_ZSTD) throw new Error(`${path} has a zstd-compressed block, which this reader cannot inflate`);
    throw new Error(`${path} has a block with unknown compression type ${type}`);
  };

  // The metaindex block holds the bloom filter, which a full scan does not need.
  const [, afterMetaOffset] = readVarint(footer, 0, "metaindex offset");
  const [, afterMetaSize] = readVarint(footer, afterMetaOffset, "metaindex size");
  const [indexOffset, afterIndexOffset] = readVarint(footer, afterMetaSize, "index offset");
  const [indexSize] = readVarint(footer, afterIndexOffset, "index size");

  const entries = [];
  for (const indexEntry of iterateBlock(inflate(indexOffset, indexSize, "index"))) {
    const [blockOffset, afterOffset] = readVarint(indexEntry.value, 0, "data block offset");
    const [blockSize] = readVarint(indexEntry.value, afterOffset, "data block size");
    for (const { key, value } of iterateBlock(inflate(blockOffset, blockSize, "data block"))) {
      entries.push({ ...splitInternalKey(key), value });
    }
  }
  return entries;
}
