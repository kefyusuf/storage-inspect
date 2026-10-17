import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterCookies } from "./filter.js";

// One column list per store family, shared by the read and delete queries: a
// cookie's contents are never loaded into this process (SQLite returns their
// lengths instead). expires_utc is deliberately absent from the Chromium list —
// it is a Windows FILETIME int64 above Number.MAX_SAFE_INTEGER, and node:sqlite
// throws when materializing it. Firefox aliases its CamelCase columns onto the
// Chromium names so one row mapper serves both, and has no encrypted_value: the
// Gecko value column is plaintext TEXT, so the length is the whole story there.
const SCHEMAS = [
  {
    table: "cookies",
    columns: `host_key, name, path, is_secure, is_httponly,
      length(value) AS value_len, length(encrypted_value) AS encrypted_len`,
  },
  {
    table: "moz_cookies",
    columns: `host AS host_key, name, path, isSecure AS is_secure, isHttpOnly AS is_httponly,
      length(value) AS value_len`,
  },
];

function mapRow(r) {
  const encLen = r.encrypted_len ?? 0;
  return {
    hostKey: r.host_key,
    name: r.name,
    path: r.path,
    isSecure: !!r.is_secure,
    isHttpOnly: !!r.is_httponly,
    hasEncrypted: encLen > 0,
    size: (r.name?.length ?? 0) + (r.value_len ?? 0) + encLen,
  };
}

// The store itself says which family it is: a file that opens but holds neither
// table is a wrong-file problem, not a lock problem, so it carries a marker the
// retry logic re-throws untouched instead of wrapping in "close the browser".
function pickSchema(db, path) {
  const tables = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name),
  );
  const schema = SCHEMAS.find((s) => tables.has(s.table));
  if (!schema) {
    throw Object.assign(
      new Error(`no cookie table in ${path}: expected Chromium's "cookies" or Firefox's "moz_cookies"`),
      { wrongSchema: true },
    );
  }
  return schema;
}

function querySource(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = pickSchema(db, path);
    return db.prepare(`SELECT ${schema.columns} FROM ${schema.table}`).all().map(mapRow);
  } finally {
    db.close();
  }
}

function queryViaCopy(path) {
  const dir = mkdtempSync(join(tmpdir(), "si-"));
  const copy = join(dir, "Cookies");
  try {
    copyFileSync(path, copy);
    return querySource(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readCookieDb(sourcePath) {
  let primaryErr;
  try {
    return querySource(sourcePath);
  } catch (err) {
    if (err.wrongSchema) throw err;
    primaryErr = err;
  }
  try {
    return queryViaCopy(sourcePath);
  } catch (err) {
    if (err.wrongSchema) throw err;
    throw new Error(
      `cannot open cookie store at ${sourcePath}: ${primaryErr.message}. ` +
        `If the browser is running it locks this file against both reading and copying — close it and retry.`,
    );
  }
}

// Real deletion: opens the ORIGINAL store read-write and removes every cookie
// that filterCookies matches (so the domain host-only/subdomain semantics live
// in exactly one place). Requires the browser to be closed. Returned entries
// never include the cookie value, and only ever list rows SQLite confirmed
// removing — one transaction, so a failure halfway leaves the store untouched.
export function deleteCookies(sourcePath, { domain, nameRegex } = {}) {
  let db;
  try {
    db = new DatabaseSync(sourcePath);
  } catch (err) {
    throw new Error(
      `cannot open cookie store for writing at ${sourcePath}: ${err.message}. ` +
        `Close the browser first.`,
    );
  }
  try {
    const schema = pickSchema(db, sourcePath);
    const rows = db.prepare(`SELECT rowid AS id, ${schema.columns} FROM ${schema.table}`).all();
    const cookies = rows.map((r) => ({ ...mapRow(r), id: Number(r.id) }));
    const matched = filterCookies(cookies, { domain, namePattern: nameRegex });

    const del = db.prepare(`DELETE FROM ${schema.table} WHERE rowid = ?`);
    db.exec(`BEGIN IMMEDIATE`);
    const gone = [];
    try {
      for (const c of matched) {
        if (del.run(c.id).changes === 1) gone.push(c);
      }
      db.exec(`COMMIT`);
    } catch (err) {
      db.exec(`ROLLBACK`);
      throw err;
    }

    const removed = gone.map(({ id, ...safe }) => safe);
    return { deleted: removed.length, removed };
  } finally {
    db.close();
  }
}
