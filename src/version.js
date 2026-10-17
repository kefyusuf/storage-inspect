export const MIN_NODE = "22.18.0";

// `parseInt` stops at the first non-digit, so "22.18.1-nightly" and "22.18.1+ds"
// both read as 18/1 here.
function parts(version) {
  return version.replace(/^v/, "").split(".").map((part) => parseInt(part, 10) || 0);
}

function atLeast(version, floor) {
  const a = parts(version);
  const b = parts(floor);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

// Returns null when this Node may open browser stores read-only, and otherwise a
// single line to print: package.json engines only produces `npm warn EBADENGINE`,
// so without this check the first thing an old Node user sees is node:sqlite
// failing to import, deep inside the cookie reader.
export function nodeVersionProblem(version) {
  if (atLeast(version, MIN_NODE)) return null;
  const found = version.startsWith("v") ? version : `v${version}`;
  return (
    `storage-inspect needs Node ${MIN_NODE} or newer, this is ${found}: ` +
    `below it node:sqlite cannot open a store read-only, which is the one thing ` +
    `this tool promises about a browser's own files.`
  );
}
