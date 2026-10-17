import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");

// The floor is not decoration: `readOnly` is what keeps the reader from opening a
// live profile read-write, and it landed on the 22 line in 22.18.0. Below that the
// option is unknown and the store is opened for writing.
test("the Node floor is high enough to open a store read-only", () => {
  const [major, minor] = pkg.engines.node.replace(/^>=\s*/, "").split(".").map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 18), `${pkg.engines.node} predates DatabaseSync readOnly`);
});

// The README is what a user reads first, so it may not disagree with package.json.
test("README states the same Node minimum as package.json engines", () => {
  const min = pkg.engines.node.replace(/^>=\s*/, "");
  assert.ok(readme.includes(`Node ${min}+`), `README must say "Node ${min}+" (engines is ${pkg.engines.node})`);
});
