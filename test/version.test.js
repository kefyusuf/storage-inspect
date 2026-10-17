import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_NODE, nodeVersionProblem } from "../src/version.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

// package.json engines is advisory: `npm install` on an older Node prints
// `npm warn EBADENGINE` and installs anyway (measured here: exit 0 by default,
// exit 1 only with --engine-strict). This is the part that actually stops it.
test("the gate's floor is the version package.json promises", () => {
  assert.equal(MIN_NODE, pkg.engines.node.replace(/^>=\s*/, ""));
});

test("a Node below the floor gets a reason, not a stack trace", () => {
  const problem = nodeVersionProblem("20.11.0");
  assert.match(problem, new RegExp(`needs Node ${MIN_NODE} or newer`));
  assert.match(problem, /v20\.11\.0/, "say what it found");
  assert.match(problem, /read-only/i, "say why: below it node:sqlite cannot open a store read-only");
});

test("versions below the floor in every position are rejected", () => {
  for (const v of ["18.20.4", "20.11.0", "22.17.0", "22.17.9"]) {
    assert.notEqual(nodeVersionProblem(v), null, `${v} is under ${MIN_NODE}`);
  }
});

test("the floor and everything above it pass", () => {
  for (const v of [MIN_NODE, "22.18.1", "22.19.0", "24.18.0", "26.8.2"]) {
    assert.equal(nodeVersionProblem(v), null, `${v} must pass`);
  }
});

test("a v prefix and build suffixes do not confuse the comparison", () => {
  assert.equal(nodeVersionProblem(`v${MIN_NODE}`), null);
  assert.equal(nodeVersionProblem(`${MIN_NODE}-nightly`), null);
  assert.notEqual(nodeVersionProblem("22.17.0-nightly"), null);
});
