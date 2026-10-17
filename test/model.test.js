import { test } from "node:test";
import assert from "node:assert/strict";
import { toInternal, summarize, removeUrl, removeParams } from "../extension/lib/model.js";

const CHROME = [
  { domain: ".example.com", name: "sess", value: "TOPSECRET", path: "/", secure: true, storeId: "0" },
  { domain: ".example.com", name: "cart", value: "ab", path: "/app", secure: false, storeId: "0" },
  { domain: "ads.net", name: "uid", value: "xyz", path: "/", secure: false, storeId: "1" },
];

test("toInternal keeps size but strips the value", () => {
  const c = toInternal(CHROME[0]);
  assert.equal(c.hostKey, ".example.com");
  assert.equal(c.name, "sess");
  assert.equal(c.size, 4 + 9); // name + value length
  assert.ok(!("value" in c), "internal shape must not carry the cookie value");
  assert.equal(c.secure, true);
  assert.equal(c.storeId, "0");
});

test("summarize filters by domain and totals size, values never present", () => {
  const r = summarize(CHROME, { domain: "example.com" });
  assert.equal(r.matched.length, 2);
  assert.equal(r.bytes, 13 + 6);
  assert.deepEqual(r.groups.map((g) => g.hostKey), [".example.com"]);
  assert.ok(!JSON.stringify(r).includes("TOPSECRET"), "summary output must not leak values");
});

test("summarize with name pattern narrows matches", () => {
  const r = summarize(CHROME, { namePattern: /^se/ });
  assert.deepEqual(r.matched.map((c) => c.name), ["sess"]);
});

test("summarize with no filters returns everything grouped by size desc", () => {
  const r = summarize(CHROME);
  assert.equal(r.matched.length, 3);
  assert.deepEqual(r.groups.map((g) => g.hostKey), [".example.com", "ads.net"]);
});

test("removeUrl reconstructs a creation URL from safe fields", () => {
  assert.equal(removeUrl(toInternal(CHROME[0])), "https://example.com/");
  assert.equal(removeUrl(toInternal(CHROME[1])), "http://example.com/app");
  assert.equal(removeUrl(toInternal(CHROME[2])), "http://ads.net/");
});

const PARTITIONED = {
  domain: ".embed.net",
  name: "sid",
  value: "TOPSECRET",
  path: "/",
  secure: true,
  storeId: "1",
  partitionKey: { topLevelSite: "https://host-a.com", hasCrossSiteAncestor: true },
};

test("toInternal keeps the partition key and still strips the value", () => {
  const c = toInternal(PARTITIONED);
  assert.deepEqual(c.partitionKey, { topLevelSite: "https://host-a.com", hasCrossSiteAncestor: true });
  assert.ok(!("value" in c), "internal shape must not carry the cookie value");
});

// chrome.cookies.remove resolves to undefined when it removed nothing, and a
// partitioned cookie is only addressed by its own partition key.
test("removeParams addresses a plain cookie by url, name and store", () => {
  assert.deepEqual(removeParams(toInternal(CHROME[0])), {
    url: "https://example.com/",
    name: "sess",
    storeId: "0",
  });
});

test("removeParams passes the partition key of a partitioned cookie", () => {
  assert.deepEqual(removeParams(toInternal(PARTITIONED)), {
    url: "https://embed.net/",
    name: "sid",
    storeId: "1",
    partitionKey: { topLevelSite: "https://host-a.com", hasCrossSiteAncestor: true },
  });
});
