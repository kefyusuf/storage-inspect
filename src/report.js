const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  return i === 0 ? `${value} ${UNITS[i]}` : `${value.toFixed(1)} ${UNITS[i]}`;
}

// Cookie values never reach the output: this is the one shape the formatters
// accept, mirroring formatStorage's origin/key/size projection.
export function safeCookie({ hostKey, name, path, isSecure, isHttpOnly, hasEncrypted, size }) {
  return { hostKey, name, path, isSecure, isHttpOnly, hasEncrypted, size };
}

export function formatCookies(list, { json = false } = {}) {
  const safe = list.map(safeCookie);
  if (json) return JSON.stringify(safe, null, 2);
  if (safe.length === 0) return "(no cookies)";
  return safe
    .map((c) => `${c.hostKey}  ${c.name}  ${humanBytes(c.size)}  ${c.path}`)
    .join("\n");
}

export function formatDu(groups, { json = false } = {}) {
  const total = groups.reduce(
    (acc, g) => ({ count: acc.count + g.count, size: acc.size + g.size }),
    { count: 0, size: 0 },
  );
  if (json) return JSON.stringify({ groups, total }, null, 2);
  const rows = groups.map((g) => `${g.hostKey}  ${g.count}  ${humanBytes(g.size)}`);
  rows.push(`\ntotal:  ${total.count} cookies,  ${humanBytes(total.size)}`);
  return rows.join("\n");
}

// Only origin, key name and size are printed. The reader no longer decodes values
// at all, but `readLocalStorage` is injectable, so this projection stays the guard.
export function formatStorage(entries, { json = false } = {}) {
  const safe = entries.map(({ origin, key, size }) => ({ origin, key, size }));
  if (json) return JSON.stringify(safe, null, 2);
  if (entries.length === 0) return "(no localStorage entries)";
  return safe.map((e) => `${e.origin}  ${e.key}  ${humanBytes(e.size)}`).join("\n");
}

export function formatStorageDu(groups, { json = false } = {}) {
  const total = groups.reduce((a, g) => ({ count: a.count + g.count, size: a.size + g.size }), { count: 0, size: 0 });
  if (json) return JSON.stringify({ groups, total }, null, 2);
  const rows = groups.map((g) => `${g.origin}  ${g.count}  ${humanBytes(g.size)}`);
  rows.push(`\ntotal:  ${total.count} entries,  ${humanBytes(total.size)}`);
  return rows.join("\n");
}
