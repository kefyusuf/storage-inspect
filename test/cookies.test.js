import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCookieDb, deleteCookies } from "../src/cookies.js";
import { filterCookies } from "../src/filter.js";

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

// The real moz_cookies shape, copied from Firefox's own CREATE TABLE for schema
// version 17 (netwerk/cookie/CookiePersistentStorage.cpp). A Firefox store has no
// encrypted_value: the value column is plaintext TEXT, which makes the length-only
// read here the whole privacy story.
function makeFirefoxDb(rows) {
  const dir = mkdtempSync(join(tmpdir(), "si-fx-"));
  dirs.push(dir);
  const path = join(dir, "cookies.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE moz_cookies (
    id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '',
    name TEXT, value TEXT, host TEXT, path TEXT,
    expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER,
    isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
    sameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0,
    isPartitionedAttributeSet INTEGER DEFAULT 0, updateTime INTEGER,
    CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes)
  )`);
  const ins = db.prepare(
    `INSERT INTO moz_cookies (name,value,host,path,expiry,isSecure,isHttpOnly,originAttributes)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    ins.run(r.name, r.value, r.host, r.path ?? "/", r.expiry ?? 0,
      r.isSecure ?? 0, r.isHttpOnly ?? 0, r.originAttributes ?? "");
  }
  db.close();
  return path;
}

test("reads a Firefox store through the same internal shape", () => {
  const path = makeFirefoxDb([
    { name: "sess", value: "abc", host: ".example.com", path: "/" },
    { name: "t", value: "xy", host: "other.com", path: "/app" },
  ]);
  const cookies = readCookieDb(path);
  assert.deepEqual(cookies.map((c) => c.hostKey), [".example.com", "other.com"]);
  assert.deepEqual(cookies.map((c) => c.name), ["sess", "t"]);
  assert.deepEqual(cookies.map((c) => c.path), ["/", "/app"]);
  assert.deepEqual(cookies.map((c) => c.size), [4 + 3, 1 + 2]); // name + value lengths
});

test("a Firefox read never carries the plaintext value", () => {
  const path = makeFirefoxDb([
    { name: "token", value: "TOPSECRET", host: "a.com" },
    { name: "empty", value: "", host: "b.com" },
  ]);
  const cookies = readCookieDb(path);
  for (const c of cookies) {
    assert.equal("value" in c, false, "reader must not carry the plaintext value");
  }
  assert.equal(JSON.stringify(cookies).includes("TOPSECRET"), false);
  assert.deepEqual(cookies.map((c) => c.size), [5 + 9, 5 + 0]);
  assert.deepEqual(cookies.map((c) => c.hasEncrypted), [false, false]);
});

test("Firefox host matching keeps the Chromium semantics", () => {
  const path = makeFirefoxDb([
    { name: "dom", value: "y", host: ".example.com" },
    { name: "only", value: "x", host: "example.com" },
    { name: "sub", value: "z", host: ".sub.example.com" },
  ]);
  assert.deepEqual(
    filterCookies(readCookieDb(path), { domain: "sub.example.com" }).map((c) => c.name),
    ["dom", "sub"],
  );
});

test("reads an old-shape moz_cookies table", () => {
  // A profile Firefox has not opened in years keeps fewer columns: originAttributes,
  // baseDomain, schemeMap and updateTime all arrived later. The reader only depends
  // on host/name/path/isSecure/isHttpOnly/value, so this must still work — and the
  // test is what proves that dependency list, not an assumption about migrations.
  const dir = mkdtempSync(join(tmpdir(), "si-fx-old-"));
  dirs.push(dir);
  const path = join(dir, "cookies.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE moz_cookies (
    id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT,
    expiry INTEGER, lastAccessed INTEGER, isSecure INTEGER, isHttpOnly INTEGER
  )`);
  db.prepare(`INSERT INTO moz_cookies (name,value,host,path,expiry,isSecure,isHttpOnly)
              VALUES (?,?,?,?,?,?,?)`).run("old", "abcd", ".legacy.com", "/", 0, 0, 0);
  db.close();

  const [c] = readCookieDb(path);
  assert.deepEqual(c, {
    hostKey: ".legacy.com",
    name: "old",
    path: "/",
    isSecure: false,
    isHttpOnly: false,
    hasEncrypted: false,
    size: 3 + 4,
  });
});

test("deleteCookies works on a Firefox store too", () => {
  // The CLI still refuses `prune --browser firefox` until this has been measured on
  // a real profile, but the shared schema list means the write path already speaks
  // moz_cookies — so that claim is tested here rather than left as dead code.
  const path = makeFirefoxDb([
    { name: "ga", value: "1", host: ".tracker.com" },
    { name: "uid", value: "2", host: ".tracker.com" },
    { name: "sess", value: "s", host: "bank.com" },
  ]);
  const res = deleteCookies(path, { domain: "tracker.com" });
  assert.equal(res.deleted, 2);
  assert.deepEqual(res.removed.map((c) => c.name).sort(), ["ga", "uid"]);
  assert.equal(JSON.stringify(res.removed).includes('"value"'), false);
  assert.deepEqual(readCookieDb(path).map((c) => c.hostKey), ["bank.com"]);
});

test("a store with neither cookie table says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-nofx-"));
  dirs.push(dir);
  const path = join(dir, "cookies.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE moz_hosts (id INTEGER PRIMARY KEY, host TEXT)`);
  db.close();
  assert.throws(
    () => readCookieDb(path),
    /no cookie table/i,
    "a wrong-file problem must be named as one",
  );
  // The lock hint is the trap: a file that opens fine but holds no cookie table is
  // not locked, and telling the user to close their browser is a lie.
  assert.throws(
    () => readCookieDb(path),
    (err) => !/close it and retry/i.test(err.message),
    "must not blame a running browser for a file that opened",
  );
});

test("maps cookie rows to the internal shape", () => {
  const path = makeCookieDb([
    { host_key: ".example.com", name: "sess", value: "abc", path: "/" },
    { host_key: "other.com", name: "t", value: "xy", path: "/app" },
  ]);
  const cookies = readCookieDb(path);
  assert.deepEqual(cookies.map((c) => c.hostKey), [".example.com", "other.com"]);
  assert.deepEqual(cookies.map((c) => c.name), ["sess", "t"]);
  assert.deepEqual(cookies.map((c) => c.path), ["/", "/app"]);
  assert.deepEqual(cookies.map((c) => c.size), [7, 3]); // name + value lengths
});

test("readCookieDb never returns cookie contents", () => {
  const path = makeCookieDb([
    { host_key: "a.com", name: "sess", value: "TOPSECRET", path: "/" },
    { host_key: "b.com", name: "enc", value: "", encrypted_value: new Uint8Array([1, 2, 3]), path: "/" },
  ]);
  const cookies = readCookieDb(path);
  for (const c of cookies) {
    assert.equal("value" in c, false, "reader must not carry the plaintext value");
    assert.equal("encrypted_value" in c, false, "reader must not carry the encrypted value");
  }
  assert.equal(JSON.stringify(cookies).includes("TOPSECRET"), false);
  // sizes still know how big the values were, without reading them
  assert.deepEqual(cookies.map((c) => c.size), [4 + 9, 3 + 0 + 3]); // name + value + encrypted lengths
  assert.deepEqual(cookies.map((c) => c.hasEncrypted), [false, true]);
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

test("readCookieDb reads real-world expiry rows without crashing", () => {
  // Chromium writes expires_utc as a Windows FILETIME int64. node:sqlite
  // refuses to materialize such a column as a JavaScript Number, so selecting
  // it breaks every real profile read.
  const path = makeCookieDb([
    { host_key: "a.com", name: "x", value: "y", path: "/", expires_utc: 13468453248547931n },
    { host_key: "b.com", name: "z", value: "w", path: "/", expires_utc: 0n },
  ]);
  const cookies = readCookieDb(path);
  assert.equal(cookies.length, 2);
  assert.equal("expiresUtc" in cookies[0], false, "expiry must not be selected as a Number");
});

test("deleteCookies works on rows with real-world expiry values", () => {
  const path = makeCookieDb([
    { host_key: "a.com", name: "x", value: "y", path: "/", expires_utc: 13468453248547931n },
  ]);
  assert.equal(deleteCookies(path, { domain: "a.com" }).deleted, 1);
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

test("the running Node honors the read-only open the reader relies on", () => {
  // On a Node older than the engines floor this option is unknown, the store is
  // opened for writing, and a live profile can grow -wal/-shm files. Fail loudly.
  const path = makeCookieDb([{ host_key: "a.com", name: "x", value: "y", path: "/" }]);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.throws(() => db.exec(`DELETE FROM cookies WHERE host_key = 'a.com'`), /readonly|read-only/i);
  } finally {
    db.close();
  }
});

test("unreadable source yields a browser-lock hint", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-lock-"));
  dirs.push(dir);
  const bogus = join(dir, "Cookies");
  writeFileSync(bogus, "not a sqlite database");
  assert.throws(() => readCookieDb(bogus), /cannot open cookie store/i);
  // The only reliable fix is closing the browser: on Windows the lock also
  // defeats a copy, so the hint must not offer one.
  assert.throws(() => readCookieDb(bogus), /close it and retry/i);
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

// A BEFORE DELETE trigger is the only way to make real SQLite disagree with the
// caller mid-batch: RAISE(ABORT) fails a statement, RAISE(IGNORE) skips a row.
function withTrigger(path, sql) {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
  return path;
}

test("deleteCookies rolls the whole batch back when a delete fails halfway", () => {
  const path = withTrigger(
    makeCookieDb([
      { host_key: "a.com", name: "one", value: "1", path: "/" },
      { host_key: "a.com", name: "two", value: "2", path: "/" },
      { host_key: "a.com", name: "three", value: "3", path: "/" },
    ]),
    `CREATE TRIGGER abort_on_two BEFORE DELETE ON cookies WHEN OLD.name = 'two'
     BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`,
  );
  assert.throws(() => deleteCookies(path, { domain: "a.com" }), /simulated failure/);
  // "one" was deleted before the failure: a half-applied prune is worse than none.
  assert.deepEqual(readCookieDb(path).map((c) => c.name), ["one", "two", "three"]);
});

test("deleteCookies counts only the rows SQLite actually removed", () => {
  const path = withTrigger(
    makeCookieDb([
      { host_key: "a.com", name: "one", value: "1", path: "/" },
      { host_key: "a.com", name: "two", value: "2", path: "/" },
      { host_key: "a.com", name: "three", value: "3", path: "/" },
    ]),
    `CREATE TRIGGER skip_two BEFORE DELETE ON cookies WHEN OLD.name = 'two'
     BEGIN SELECT RAISE(IGNORE); END`,
  );
  const res = deleteCookies(path, { domain: "a.com" });
  assert.equal(res.deleted, 2, "a skipped delete is not a deletion");
  assert.deepEqual(res.removed.map((c) => c.name), ["one", "three"]);
  assert.deepEqual(readCookieDb(path).map((c) => c.name), ["two"]);
});
