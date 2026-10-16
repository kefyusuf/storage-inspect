import { test } from "node:test";
import assert from "node:assert/strict";
import { filterCookies, groupByDomain, totalSize, cookieSize } from "../src/filter.js";

const CS = [
  { hostKey: ".example.com", name: "sess", value: "12345" },  // 4+5=9 domain cookie
  { hostKey: "example.com", name: "only", value: "x" },       // 4+1=5 host-only cookie
  { hostKey: ".sub.example.com", name: "c", value: "yz" },    // 1+2=3
  { hostKey: "other.com", name: "o", value: "abcdef" },       // 1+6=7
];

test("domain cookie (.example.com) matches the apex host", () => {
  const r = filterCookies(CS, { domain: "example.com" });
  assert.deepEqual(r.map((c) => c.name).sort(), ["only", "sess"]);
});

test("leading dot in filter domain is normalized", () => {
  const r = filterCookies(CS, { domain: ".example.com" });
  assert.deepEqual(r.map((c) => c.name).sort(), ["only", "sess"]);
});

test("domain cookie applies to subdomains, host-only does not", () => {
  const r = filterCookies(CS, { domain: "sub.example.com" });
  assert.deepEqual(r.map((c) => c.name).sort(), ["c", "sess"]);
});

test("exact hostKey match for unrelated domain", () => {
  assert.deepEqual(filterCookies(CS, { domain: "other.com" }).map((c) => c.name), ["o"]);
});

test("no domain returns all", () => {
  assert.equal(filterCookies(CS, {}).length, 4);
});

test("namePattern as RegExp filters by name", () => {
  assert.deepEqual(filterCookies(CS, { namePattern: /^se/ }).map((c) => c.name), ["sess"]);
});

test("namePattern as string is treated as a regex", () => {
  const r = filterCookies(CS, { namePattern: "o" });
  assert.deepEqual(r.map((c) => c.name).sort(), ["o", "only"]);
});

test("domain + namePattern combine with AND", () => {
  assert.deepEqual(
    filterCookies(CS, { domain: "example.com", namePattern: "only" }).map((c) => c.name),
    ["only"],
  );
});

test("cookieSize sums name + value length", () => {
  assert.equal(cookieSize({ name: "sess", value: "12345" }), 9);
});

test("cookieSize prefers an explicit size field when present", () => {
  assert.equal(cookieSize({ name: "a", value: "b", size: 42 }), 42);
});

test("cookieSize handles missing value", () => {
  assert.equal(cookieSize({ name: "token" }), 5);
});

test("totalSize sums all cookie sizes", () => {
  assert.equal(totalSize(CS), 9 + 5 + 3 + 7);
});

test("groupByDomain aggregates count and size, sorted by size desc", () => {
  assert.deepEqual(groupByDomain(CS), [
    { hostKey: ".example.com", count: 1, size: 9 },
    { hostKey: "other.com", count: 1, size: 7 },
    { hostKey: "example.com", count: 1, size: 5 },
    { hostKey: ".sub.example.com", count: 1, size: 3 },
  ]);
});

test("groupByDomain merges same hostKey", () => {
  const g = groupByDomain([
    { hostKey: "a.com", name: "x", value: "1" },
    { hostKey: "a.com", name: "y", value: "22" },
  ]);
  assert.deepEqual(g, [{ hostKey: "a.com", count: 2, size: 5 }]);
});

test("groupByDomain on empty list", () => {
  assert.deepEqual(groupByDomain([]), []);
});
