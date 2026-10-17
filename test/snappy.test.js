import { test } from "node:test";
import assert from "node:assert/strict";
import { snappyUncompress } from "../src/snappy.js";

// Byte-level fixtures written by hand from google/snappy's
// format_description.txt: an encoder written in the same session as the
// decoder would agree with its own bug.
const bytes = (...xs) => Buffer.from(xs);

test("the preamble is a little-endian varint, so lengths over 127 span bytes", () => {
  // 300 = 0b1_0101100 -> 0xac 0x02. Then a 300-byte literal, which needs the
  // long form: tag 0xf4 says "two length bytes follow", and they hold
  // len-1 = 299 little-endian.
  const literal = Buffer.concat([bytes(0xf4, 0x2b, 0x01), Buffer.alloc(300, 0x61)]);
  const out = snappyUncompress(Buffer.concat([bytes(0xac, 0x02), literal]));
  assert.equal(out.length, 300);
  assert.deepEqual([...new Set(out)], [0x61]);
});

test("literal up to 60 bytes: (len-1) lives in the tag", () => {
  const input = bytes(0x04, 0x0c, 0x01, 0x02, 0x03, 0x04); // 0x0c = (4-1)<<2
  assert.deepEqual([...snappyUncompress(input)], [0x01, 0x02, 0x03, 0x04]);
});

test("copy with a 1-byte offset can overlap the bytes it is producing", () => {
  // The doc's own RLE example: "xab" then copy offset=2 length=4 -> "xababab".
  // The source of a copy is the *output* being built, and it moves as the copy
  // writes, so this case fails for any implementation that reads the length away
  // in the input stream or fixes the source address up front.
  const input = bytes(0x07, 0x08, 0x78, 0x61, 0x62, 0x01, 0x02);
  assert.equal(snappyUncompress(input).toString("latin1"), "xababab");
});

test("copy with a 2-byte offset: (len-1) in the tag's upper six bits", () => {
  const input = bytes(0x0a, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x16, 0x04, 0x00);
  assert.equal(snappyUncompress(input).toString("latin1"), "abcdabcdab");
});

test("copy with a 4-byte offset", () => {
  const input = bytes(0x0a, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x17, 0x04, 0x00, 0x00, 0x00);
  assert.equal(snappyUncompress(input).toString("latin1"), "abcdabcdab");
});

test("a 2-byte-offset copy is not satisfied with the low byte", () => {
  // Offsets above 255 are routine in a 32 kB block, and this form is where they
  // come from: 300 = 0x2c 0x01 little-endian.
  const base = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) % 251));
  const input = Buffer.concat([
    bytes(0xb0, 0x02), // preamble: 304
    bytes(0xf4, 0x2b, 0x01), // literal of 300 bytes
    base,
    bytes(0x0e, 0x2c, 0x01), // copy 4 bytes from 300 back
  ]);
  const out = snappyUncompress(input);
  assert.equal(out.length, 304);
  assert.ok(out.subarray(300).equals(out.subarray(0, 4)), "must copy the first four bytes");
});

test("an offset of zero is not a legal copy", () => {
  const input = bytes(0x03, 0x04, 0x61, 0x62, 0x01, 0x00);
  assert.throws(() => snappyUncompress(input), /offset/i);
});

test("a copy reaching further back than what is decoded is refused", () => {
  const input = bytes(0x03, 0x04, 0x61, 0x62, 0x01, 0x03); // offset 3, only 2 bytes so far
  assert.throws(() => snappyUncompress(input), /past|beyond|behind/i);
});

test("more output than the preamble promised is refused", () => {
  const input = bytes(0x02, 0x08, 0x61, 0x62, 0x63);
  assert.throws(() => snappyUncompress(input), /length|trailing/i);
});

test("less output than the preamble promised is refused", () => {
  const input = bytes(0x05, 0x08, 0x61, 0x62, 0x63);
  assert.throws(() => snappyUncompress(input), /length|short|truncated/i);
});

test("a truncated literal is refused instead of inventing bytes", () => {
  const input = bytes(0x0a, 0x24, 0x61, 0x62); // tag promises 10 literal bytes
  assert.throws(() => snappyUncompress(input), /truncat|length/i);
});

test("a copy that would pass the promised length is refused", () => {
  // A two-byte literal then four copies of four bytes each: the fourth would
  // write byte 18 of a stream that promised 16.
  const input = bytes(0x10, 0x04, 0x61, 0x62, 0x01, 0x02, 0x01, 0x02, 0x01, 0x02, 0x01, 0x02);
  assert.throws(() => snappyUncompress(input), /does not fit/);
});

test("a stream with no preamble at all is refused", () => {
  assert.throws(() => snappyUncompress(Buffer.alloc(0)), /preamble/);
});

test("a preamble varint longer than five bytes is refused", () => {
  // Five bytes are the most any value under 2^32 can need, so a sixth
  // continuation bit means the length itself is corrupt.
  assert.throws(() => snappyUncompress(bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01)), /five bytes/);
});

test("a preamble that promises more than the reader will allocate is refused", () => {
  // 2^32-1: a legal snappy length, and far past the cap on one block.
  assert.throws(() => snappyUncompress(bytes(0xff, 0xff, 0xff, 0xff, 0x0f)), /impossible uncompressed length/);
});

test("a 1-byte-offset copy carries the full 11-bit offset", () => {
  // 2047 is the largest offset this form can name: the upper three bits sit in
  // the tag (0b111) and the low byte follows it. Dropping the high bits would
  // copy from 255 back instead, so the pattern has to vary or that is invisible.
  const base = Buffer.from(Array.from({ length: 2047 }, (_, i) => i % 251));
  const input = Buffer.concat([
    bytes(0x83, 0x10), // preamble: 2051
    bytes(0xf4, 0xfe, 0x07), // literal of 2047 bytes (tag 0xf4: two length bytes, 2046)
    base,
    bytes(0xe1, 0xff), // copy 4 bytes from 2047 back
  ]);
  const out = snappyUncompress(input);
  assert.equal(out.length, 2051);
  assert.ok(out.subarray(2047).equals(out.subarray(0, 4)), "must copy the first four bytes");
  assert.ok(!out.subarray(2047).equals(out.subarray(1792, 1796)), "offset 255 would land here");
});
