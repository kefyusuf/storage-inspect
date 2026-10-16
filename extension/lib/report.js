// GENERATED — do not edit. Copy of src/<file> for the MV3 extension bundle.
// Refresh with `npm run build:extension`.

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

export function formatCookies(list, { json = false } = {}) {
  if (json) return JSON.stringify(list, null, 2);
  if (list.length === 0) return "(no cookies)";
  return list
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

// localStorage values are never printed — only origin, key name and size.
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
