import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterCookies } from "./filter.js";

function toBytes(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (value.length != null) return value.length; // Buffer / Uint8Array
  return 0;
}

const SELECT = `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly FROM cookies`;

function mapRow(r) {
  const encLen = toBytes(r.encrypted_value);
  return {
    hostKey: r.host_key,
    name: r.name,
    value: r.value ?? "",
    path: r.path,
    expiresUtc: Number(r.expires_utc),
    isSecure: !!r.is_secure,
    isHttpOnly: !!r.is_httponly,
    hasEncrypted: encLen > 0,
    size: toBytes(r.name) + toBytes(r.value) + encLen,
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
        `If the browser is running, close it (or copy the profile directory) and retry.`,
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
    const rows = db
      .prepare(
        `SELECT rowid AS id, host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly FROM cookies`,
      )
      .all();
    const cookies = rows.map((r) => ({ ...mapRow(r), id: Number(r.id) }));
    const matched = filterCookies(cookies, { domain, namePattern: nameRegex });

    const del = db.prepare(`DELETE FROM cookies WHERE rowid = ?`);
    for (const c of matched) del.run(c.id);

    const removed = matched.map(({ id, value, ...safe }) => safe);
    return { deleted: removed.length, removed };
  } finally {
    db.close();
  }
}
