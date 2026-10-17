// Snappy decompression, the one compression LevelDB writes into *.ldb blocks.
// Byte layout from google/snappy's format_description.txt: a varint preamble
// with the uncompressed length, then a flat sequence of literals and copies.
// There is no framing and no entropy layer, so this is the whole format.

// The preamble may name up to 2^32-1 bytes. A single corrupt length must not
// make this program try to allocate that, and no real block is anywhere near it.
const MAX_UNCOMPRESSED = 1 << 26;

export function snappyUncompress(buf) {
  let at = 0;
  let expected = 0;
  let scale = 1;
  for (;;) {
    if (at >= buf.length) throw new Error("snappy: stream has no preamble length");
    const byte = buf[at++];
    expected += (byte & 0x7f) * scale;
    scale *= 128;
    if ((byte & 0x80) === 0) break;
    if (scale > 2 ** 32) throw new Error("snappy: preamble varint is longer than five bytes");
  }
  if (!Number.isSafeInteger(expected) || expected > MAX_UNCOMPRESSED) {
    throw new Error(`snappy: impossible uncompressed length ${expected}`);
  }

  const out = Buffer.allocUnsafe(expected);
  let written = 0;

  const room = (count, what) => {
    if (written + count > expected) {
      throw new Error(`snappy: ${what} of ${count} bytes does not fit the ${expected}-byte length`);
    }
  };

  while (at < buf.length) {
    const tag = buf[at++];
    const kind = tag & 3;

    if (kind === 0) {
      let size = tag >> 2;
      if (size >= 60) {
        const lengthBytes = size - 59;
        if (at + lengthBytes > buf.length) throw new Error("snappy: truncated literal length");
        size = 0;
        for (let i = 0; i < lengthBytes; i++) size += buf[at + i] * 256 ** i;
        at += lengthBytes;
        size += 1;
      } else {
        size += 1;
      }
      if (at + size > buf.length) {
        throw new Error(`snappy: truncated literal, needs ${size} bytes and ${buf.length - at} are left`);
      }
      room(size, "literal");
      out.set(buf.subarray(at, at + size), written);
      at += size;
      written += size;
      continue;
    }

    let size;
    let offset;
    if (kind === 1) {
      size = ((tag >> 2) & 7) + 4;
      if (at >= buf.length) throw new Error("snappy: truncated copy offset");
      offset = (tag >> 5) * 256 + buf[at++];
    } else {
      size = (tag >> 2) + 1;
      const width = kind === 2 ? 2 : 4;
      if (at + width > buf.length) throw new Error("snappy: truncated copy offset");
      offset = 0;
      for (let i = 0; i < width; i++) offset += buf[at + i] * 256 ** i;
      at += width;
    }

    if (offset === 0) throw new Error("snappy: copy with offset 0 is not legal");
    if (offset > written) {
      throw new Error(`snappy: copy of ${offset} bytes back reaches past ${written} decoded bytes`);
    }
    room(size, "copy");
    // A copy may overlap the bytes it is producing (that is how run-length runs
    // are encoded), so it must be byte by byte, never a bulk copy.
    const src = written - offset;
    for (let i = 0; i < size; i++) out[written + i] = out[src + i];
    written += size;
  }

  if (written !== expected) {
    throw new Error(`snappy: truncated stream, ${written} of ${expected} bytes decoded`);
  }
  return out;
}
