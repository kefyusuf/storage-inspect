import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const call = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const MAIN = join(root, "src", "main.js");

// A loader hook that makes node:sqlite unresolvable — the closest this machine can
// get to a Node that does not ship it. Anything the CLI can answer without opening a
// cookie store must still answer, and anything that cannot must say so in one line
// instead of dumping module-loader internals.
const dir = mkdtempSync(join(tmpdir(), "si-entry-"));
writeFileSync(
  join(dir, "loader.mjs"),
  `export async function resolve(specifier, context, next) {
  if (specifier === "node:sqlite") {
    throw Object.assign(new Error("No such built-in module: node:sqlite"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
  }
  return next(specifier, context);
}
`,
);
writeFileSync(
  join(dir, "register.mjs"),
  `import { register } from "node:module";\nregister("./loader.mjs", import.meta.url);\n`,
);
// Same trick for the version floor: this machine has no old Node binary, but the
// entry point only ever reads process.versions.node, so a hook can hand it a lie.
writeFileSync(
  join(dir, "old-node.mjs"),
  `Object.defineProperty(process.versions, "node", { value: "20.11.0", configurable: true });\n`,
);
const IMPORT = `--import=${pathToFileURL(join(dir, "register.mjs")).href}`;
const OLD = `--import=${pathToFileURL(join(dir, "old-node.mjs")).href}`;

async function node(args) {
  try {
    const { stdout, stderr } = await call(process.execPath, args, {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("the entry point answers --help", async () => {
  const { code, out } = await node([MAIN, "--help"]);
  assert.equal(code, 0, out);
  assert.match(out, /storage-inspect —/);
});

test("help and the localStorage commands never import node:sqlite", async () => {
  const help = await node([IMPORT, MAIN, "--help"]);
  assert.equal(help.code, 0, help.out);
  assert.match(help.out, /localstorage du/);

  const du = await node([IMPORT, MAIN, "localstorage", "du", "--browser", "edge", "--profile", "NoSuchProfile"]);
  assert.equal(du.code, 1, du.out);
  assert.match(du.out, /storage-inspect:/, "the CLI's own one-line error");
  assert.ok(!/ERR_UNKNOWN_BUILTIN_MODULE|node:internal/.test(du.out), `no module-loader internals may leak:\n${du.out}`);
});

test("a cookie command on a sqlite-less runtime fails with one line, not a trace", async () => {
  const { code, out } = await node([IMPORT, MAIN, "cookies", "ls", "--browser", "edge", "--profile", "Default"]);
  assert.equal(code, 1, out);
  assert.match(out, /^storage-inspect: /m);
  assert.ok(!/node:internal/.test(out), `expected no internal stack trace:\n${out}`);
});

test("a Node below the floor is refused, and nothing else runs", async () => {
  const { code, out } = await node([OLD, MAIN, "--help"]);
  assert.equal(code, 2, out);
  assert.match(out, /needs Node 22\.18\.0 or newer/);
  assert.match(out, /v20\.11\.0/);
  assert.ok(!out.includes("localstorage du"), `the CLI must not run after the refusal:\n${out}`);
});

test("the version floor is checked before a store is opened", async () => {
  const { code, out } = await node([OLD, IMPORT, MAIN, "cookies", "ls"]);
  assert.equal(code, 2, out);
  assert.match(out, /needs Node 22\.18\.0 or newer/);
  assert.ok(!/ERR_UNKNOWN_BUILTIN_MODULE|node:internal/.test(out), `the floor is the answer, not the loader:\n${out}`);
});
