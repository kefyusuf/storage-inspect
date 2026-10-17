import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The bundle only has to survive one thing: being loaded unpacked by a browser,
// where a broken path is a silent service-worker failure and a missing element id
// is a popup that never starts. No automation here can reach chrome:// to load it,
// so these are checked the way a packager would — from the files on disk.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extDir = join(root, "extension");
const read = (...parts) => readFileSync(join(extDir, ...parts), "utf8");

function jsFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full, base);
    return e.name.endsWith(".js") ? [full] : [];
  });
}

test("manifest is MV3 and names files that are in the bundle", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["cookies"]);
  assert.ok(manifest.host_permissions.includes("<all_urls>"), "remove() needs the cookie's creation URL");
  assert.ok(existsSync(join(extDir, manifest.background.service_worker)));
  assert.equal(manifest.background.type, "module", "background.js imports ES modules");
  const popup = join(extDir, manifest.action.default_popup);
  assert.ok(existsSync(popup));
});

test("every import inside the bundle resolves to a file in the bundle", () => {
  for (const file of jsFiles(extDir)) {
    for (const spec of read(relative(extDir, file)).matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = resolve(dirname(file), spec[1]);
      assert.ok(existsSync(target), `${relative(extDir, file)} imports ${spec[1]}, which is not there`);
      assert.ok(target.startsWith(extDir), `${spec[1]} reaches outside extension/, where an unpacked load cannot follow it`);
    }
  }
});

// popup.js only ever looks elements up by id; if popup.html stops providing one,
// refresh() throws on the first click and the popup shows nothing at all.
test("popup.html provides every element popup.js looks up", () => {
  const html = read("popup.html");
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = [...read("popup.js").matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 5, "the id lookup must actually be found by this test");
  for (const id of used) assert.ok(declared.has(id), `popup.html has no #${id}`);
});

// extension/lib/{filter,report}.js are generated copies of src/ modules. A stale
// mirror is invisible to CI: the CLI and the popup would simply disagree.
test("the generated extension mirrors still equal their sources", () => {
  for (const name of ["filter.js", "report.js"]) {
    const mirror = read("lib", name);
    assert.match(mirror, /^\/\/ GENERATED/, `${name} lost its generated header`);
    const body = mirror.replace(/^\/\/ GENERATED[\s\S]*?\n\n/, "");
    assert.equal(body, readFileSync(join(root, "src", name), "utf8"), `extension/lib/${name} is stale — run npm run build:extension`);
  }
});

function relative(base, file) {
  return file.slice(base.length + 1).replace(/\\/g, "/");
}
