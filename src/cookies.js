import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterCookies } from "./filter.js";

// One column list, shared by the read and delete queries: a cookie's contents are
// never loaded into this process (SQLite returns their lengths instead), and
// expires_utc is deliberately absent — Chromium writes it as a Windows FILETIME
// int64 above Number.MAX_SAFE_INTEGER, and node:sqlite throws when materializing it.
const COLUMNS = `host_key, name, path, is_secure, is_httponly,
  length(value) AS value_len, length(encrypted_value) AS encrypted_len`;

const SELECT = `SELECT ${COLUMNS} FROM cookies`;

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

function querySource(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(SELECT).all().map(mapRow);
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
    primaryErr = err;
  }
  try {
    return queryViaCopy(sourcePath);
  } catch {
    throw new Error(
      `cannot open cookie store at ${sourcePath}: ${primaryErr.message}. ` +
        `If the browser is running it locks this file against both reading and copying — close it and retry.`,
    );
  }
}

// Real deletion: opens the ORIGINAL store read-write and removes every cookie
// that filterCookies matches (so the domain host-only/subdomain semantics live
// in exactly one place). Requires the browser to be closed. Returned entries
// never include the cookie value.
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
    const rows = db.prepare(`SELECT rowid AS id, ${COLUMNS} FROM cookies`).all();
    const cookies = rows.map((r) => ({ ...mapRow(r), id: Number(r.id) }));
    const matched = filterCookies(cookies, { domain, namePattern: nameRegex });

    const del = db.prepare(`DELETE FROM cookies WHERE rowid = ?`);
    for (const c of matched) del.run(c.id);

    const removed = matched.map(({ id, ...safe }) => safe);
    return { deleted: removed.length, removed };
  } finally {
    db.close();
  }
}
