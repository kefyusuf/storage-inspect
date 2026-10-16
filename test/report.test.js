import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCookies, formatDu, formatStorage, formatStorageDu, humanBytes } from "../src/report.js";

const CK = [
  { hostKey: ".example.com", name: "sess", value: "TOPSECRET", path: "/", size: 9 },
  { hostKey: "other.com", name: "t", value: "TOPSECRET", path: "/app", size: 5 },
];

test("humanBytes formats B and KB", () => {
  assert.equal(humanBytes(9), "9 B");
  assert.equal(humanBytes(1024), "1.0 KB");
  assert.equal(humanBytes(1536), "1.5 KB");
  assert.equal(humanBytes(1048576), "1.0 MB");
});

test("formatCookies lists one row per cookie without leaking values", () => {
  const out = formatCookies(CK);
  assert.match(out, /\.example.com\s+sess\s+9 B\s+\//);
  assert.match(out, /other\.com\s+t\s+5 B\s+\/app/);
  assert.ok(!out.includes("value"), "must not print cookie values");
});

test("formatCookies with json returns parseable array", () => {
  const parsed = JSON.parse(formatCookies(CK, { json: true }));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].hostKey, ".example.com");
});

test("formatCookies json strips values like formatStorage does", () => {
  const out = formatCookies(CK, { json: true });
  assert.ok(!out.includes("TOPSECRET"), "must not print cookie values");
  assert.equal(JSON.parse(out).every((c) => !("value" in c)), true, "json must not carry a value field");
});

test("formatCookies empty shows a marker", () => {
  assert.match(formatCookies([]), /no cookies/);
});

test("formatDu prints per-domain totals and a grand total", () => {
  const out = formatDu([
    { hostKey: ".example.com", count: 3, size: 100 },
    { hostKey: "a.com", count: 1, size: 10 },
  ]);
  assert.match(out, /\.example.com\s+3\s+100 B/);
  assert.match(out, /a\.com\s+1\s+10 B/);
  assert.match(out, /total:\s+4 cookies,\s+110 B/);
});

test("formatDu json", () => {
  const parsed = JSON.parse(formatDu([{ hostKey: "x", count: 2, size: 8 }], { json: true }));
  assert.deepEqual(parsed, { groups: [{ hostKey: "x", count: 2, size: 8 }], total: { count: 2, size: 8 } });
});

const LS = [
  { origin: "https://a.com", key: "color", value: "TOPSECRET", size: 12 },
  { origin: "https://b.com", key: "n", value: "x", size: 3 },
];

test("formatStorage lists origin + key + size, never the value", () => {
  const out = formatStorage(LS);
  assert.match(out, /https:\/\/a\.com\s+color\s+12 B/);
  assert.ok(!out.includes("TOPSECRET"), "must not print localStorage values");
});

test("formatStorage json strips value", () => {
  const parsed = JSON.parse(formatStorage(LS, { json: true }));
  assert.equal(parsed.length, 2);
  assert.equal("value" in parsed[0], false);
});

test("formatStorage empty marker", () => {
  assert.match(formatStorage([]), /no localStorage/i);
});

test("formatStorageDu totals per origin", () => {
  const out = formatStorageDu([{ origin: "https://a.com", count: 2, size: 100 }]);
  assert.match(out, /https:\/\/a\.com\s+2\s+100 B/);
  assert.match(out, /total:\s+2 entries,\s+100 B/);
});
