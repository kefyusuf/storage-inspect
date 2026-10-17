import { test } from "node:test";
import assert from "node:assert/strict";

// chrome.cookies hands the extension full cookie objects, values included. This
// file drives the service worker's real entry point — the onMessage listener it
// registers while importing — so the popup↔worker contract is covered without a
// browser: which rows a message touches, which params reach remove(), and what
// shape comes back to the UI.

const COOKIE = (over) => ({
  value: "TOPSECRET",
  path: "/",
  secure: false,
  storeId: "0",
  ...over,
});

const STORE = [
  COOKIE({ domain: ".example.com", name: "sess", secure: true }),
  COOKIE({ domain: ".example.com", name: "_ga_1" }),
  COOKIE({ domain: ".example.com", name: "chip", path: "/app", secure: true, partitionKey: { topLevelSite: "https://partner.dev", hasCrossSiteAncestor: true } }),
  COOKIE({ domain: ".sub.example.com", name: "child" }),
  COOKIE({ domain: "ads.net", name: "uid", storeId: "1" }),
];

// size = name + value length, so these are pinned by name: "sess" 4+9=13,
// "_ga_1" 5+9=14, "chip" 4+9=13, "child" 5+9=14, "uid" 3+9=12.
const seen = { getAll: [], remove: [] };
let refused = new Set();
let listener;

globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
  cookies: {
    async getAll(query) {
      seen.getAll.push(query);
      // Chromium's domain filter is a domain match: "example.com" also answers
      // for ".sub.example.com", which is why the group header needs its own cut.
      if (!query.domain) return STORE.slice();
      return STORE.filter((c) => c.domain === query.domain || c.domain.endsWith(`.${query.domain}`));
    },
    async remove(params) {
      seen.remove.push(params);
      // resolve to undefined = the store removed nothing, exactly as the real API
      if (refused.has(params.name)) return undefined;
      return { name: params.name, url: params.url, storeId: params.storeId };
    },
  },
};

await import("../extension/background.js");
const ask = (msg) => new Promise((resolve) => listener(msg, {}, resolve));

function reset() {
  seen.getAll.length = 0;
  seen.remove.length = 0;
  refused = new Set();
}

test("ls: filters with the query chrome expects and never returns a value", async () => {
  reset();
  const res = await ask({ type: "ls", domain: "example.com", nameRegex: "^(sess|chip)$" });
  assert.deepEqual(seen.getAll, [{ domain: "example.com" }], "the leading dot must not reach the query");
  assert.equal(res.count, 2);
  assert.equal(res.bytes, 13 + 13);
  assert.deepEqual(res.groups, [{ hostKey: ".example.com", count: 2, size: 26 }]);
  assert.deepEqual(res.matched.map((c) => c.name), ["sess", "chip"]);
  assert.ok(!JSON.stringify(res).includes("TOPSECRET"), "the reply is what the popup renders: no value may ride along");
});

test("ls: without filters every cookie is listed", async () => {
  reset();
  const res = await ask({ type: "ls" });
  assert.deepEqual(seen.getAll, [{}]);
  assert.equal(res.count, 5);
});

test("remove: addresses the cookie exactly as it was listed, partition key included", async () => {
  reset();
  const { matched } = await ask({ type: "ls", domain: "example.com" });
  const chip = matched.find((c) => c.name === "chip");
  reset();

  const res = await ask({ type: "remove", cookie: chip });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(seen.remove, [
    { url: "https://example.com/app", name: "chip", storeId: "0", partitionKey: { topLevelSite: "https://partner.dev", hasCrossSiteAncestor: true } },
  ], "a partitioned cookie is only addressed together with its partition key");
});

test("remove: an API reply of undefined is a failure, not a deletion", async () => {
  reset();
  refused = new Set(["sess"]);
  const res = await ask({ type: "remove", cookie: { hostKey: ".example.com", name: "sess", path: "/", secure: true, storeId: "0", size: 13 } });
  assert.deepEqual(res, { ok: false });
});

test("removeGroup: a group header deletes the rows it counted, not the domain around it", async () => {
  reset();
  const res = await ask({ type: "removeGroup", hostKey: ".example.com" });
  assert.deepEqual(res, { deleted: 3, wanted: 3 });
  assert.deepEqual(seen.remove.map((p) => p.name), ["sess", "_ga_1", "chip"]);
  assert.ok(
    !seen.remove.some((p) => p.name === "child"),
    ".sub.example.com was listed under its own header, so this header must not reach it",
  );
});

test("removeGroup: a host-only header stays on its own host", async () => {
  reset();
  const res = await ask({ type: "removeGroup", hostKey: "ads.net" });
  assert.deepEqual(res, { deleted: 1, wanted: 1 });
  assert.deepEqual(seen.remove.map((p) => p.name), ["uid"]);
});

test("removeGroup: deletes under the name filter the group was listed with", async () => {
  reset();
  const res = await ask({ type: "removeGroup", hostKey: ".example.com", nameRegex: "^_ga" });
  assert.deepEqual(res, { deleted: 1, wanted: 1 });
  assert.deepEqual(seen.remove.map((p) => p.name), ["_ga_1"]);
});

test("removeGroup: reports a partial refusal as partial, not as done", async () => {
  reset();
  refused = new Set(["chip"]);
  const res = await ask({ type: "removeGroup", hostKey: ".example.com" });
  assert.deepEqual(res, { deleted: 2, wanted: 3 }, "the popup compares these two numbers out loud");
  assert.deepEqual(seen.remove.map((p) => p.name), ["sess", "_ga_1", "chip"]);
});

test("an unknown message type comes back as an error reply, not a rejected port", async () => {
  reset();
  const res = await ask({ type: "purge" });
  assert.match(res.error, /unknown message type: purge/);
});
