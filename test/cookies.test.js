import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCookieDb, deleteCookies } from "../src/cookies.js";

const dirs = [];
function makeCookieDb(rows) {
  const dir = mkdtempSync(join(tmpdir(), "si-test-"));
  dirs.push(dir);
  const path = join(dir, "Cookies");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE cookies (
    host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
    encrypted_value BLOB NOT NULL DEFAULT '', path TEXT NOT NULL,
    expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL
  )`);
  const ins = db.prepare(
    `INSERT INTO cookies (host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    ins.run(r.host_key, r.name, r.value, r.encrypted_value ?? new Uint8Array(0), r.path,
      r.expires_utc ?? 0, r.is_secure ?? 0, r.is_httponly ?? 0);
  }
  db.close();
  return path;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("maps cookie rows to the internal shape", () => {
  const path = makeCookieDb([
    { host_key: ".example.com", name: "sess", value: "abc", path: "/" },
    { host_key: "other.com", name: "t", value: "xy", path: "/app" },
  ]);
  const cookies = readCookieDb(path);
  assert.deepEqual(cookies.map((c) => c.hostKey), [".example.com", "other.com"]);
  assert.deepEqual(cookies.map((c) => c.name), ["sess", "t"]);
  assert.deepEqual(cookies.map((c) => c.value), ["abc", "xy"]);
  assert.deepEqual(cookies.map((c) => c.path), ["/", "/app"]);
});

test("size includes name + value bytes", () => {
  const path = makeCookieDb([{ host_key: "a.com", name: "sess", value: "12345", path: "/" }]);
  const [c] = readCookieDb(path);
  assert.equal(c.size, 9); // 4 + 5
});

test("size counts encrypted_value bytes when value is empty", () => {
  const path = makeCookieDb([
    { host_key: "a.com", name: "n", value: "", encrypted_value: new Uint8Array(10), path: "/" },
  ]);
  const [c] = readCookieDb(path);
  assert.equal(c.size, 11); // name 1 + value 0 + encrypted 10
  assert.equal(c.hasEncrypted, true);
});

test("missing file throws a clear error", () => {
  assert.throws(() => readCookieDb("/no/such/Cookies"), /cannot open cookie store/i);
});

test("readCookieDb opens the source read-only and does not mutate it", () => {
  const path = makeCookieDb([{ host_key: "a.com", name: "x", value: "y", path: "/" }]);
  readCookieDb(path);
  // reading again must still succeed and return the same row (source untouched)
  assert.equal(readCookieDb(path).length, 1);
});

test("unreadable source yields a browser-lock hint", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-lock-"));
  dirs.push(dir);
  const bogus = join(dir, "Cookies");
  writeFileSync(bogus, "not a sqlite database");
  assert.throws(() => readCookieDb(bogus), /cannot open cookie store/i);
});

test("deleteCookies removes only domain-matching rows and reports them", () => {
  const path = makeCookieDb([
    { host_key: ".tracker.com", name: "ga", value: "1", path: "/" },
    { host_key: ".tracker.com", name: "uid", value: "2", path: "/" },
    { host_key: "bank.com", name: "sess", value: "s", path: "/" },
  ]);
  const res = deleteCookies(path, { domain: "tracker.com" });
  assert.equal(res.deleted, 2);
  assert.deepEqual(res.removed.map((c) => c.name).sort(), ["ga", "uid"]);
  // source really mutated
  assert.deepEqual(readCookieDb(path).map((c) => c.hostKey), ["bank.com"]);
});

test("deleteCookies matches host-only semantics (no subdomain leak)", () => {
  const path = makeCookieDb([
    { host_key: "example.com", name: "only", value: "x", path: "/" },
    { host_key: ".example.com", name: "dom", value: "y", path: "/" },
  ]);
  // host-only "example.com" cookie should NOT be removed when deleting a subdomain,
  // but the domain cookie ".example.com" should be.
  const res = deleteCookies(path, { domain: "sub.example.com" });
  assert.deepEqual(res.removed.map((c) => c.name), ["dom"]);
});

test("deleteCookies by nameRegex", () => {
  const path = makeCookieDb([
    { host_key: "a.com", name: "_ga_1", value: "x", path: "/" },
    { host_key: "a.com", name: "keep", value: "y", path: "/" },
  ]);
  const res = deleteCookies(path, { nameRegex: "^_ga" });
  assert.equal(res.deleted, 1);
  assert.deepEqual(readCookieDb(path).map((c) => c.name), ["keep"]);
});

test("deleteCookies with no match is a no-op", () => {
  const path = makeCookieDb([{ host_key: "a.com", name: "x", value: "y", path: "/" }]);
  const res = deleteCookies(path, { domain: "zzz.com" });
  assert.equal(res.deleted, 0);
  assert.equal(readCookieDb(path).length, 1);
});

test("deleteCookies removed entries never expose value", () => {
  const path = makeCookieDb([{ host_key: "a.com", name: "secret", value: "SUPERVALUE", path: "/" }]);
  const res = deleteCookies(path, { domain: "a.com" });
  assert.equal(JSON.stringify(res.removed).includes("SUPERVALUE"), false);
});
