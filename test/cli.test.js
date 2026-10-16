import { test } from "node:test";
import assert from "node:assert/strict";
import { run, parseCommand } from "../src/cli.js";

const SAMPLE = [
  { hostKey: ".example.com", name: "sess", value: "TOPSECRET", path: "/", size: 9 },
  { hostKey: ".example.com", name: "cart", value: "TOPSECRET", path: "/", size: 8 },
  { hostKey: "ads.net", name: "uid", value: "TOPSECRET", path: "/", size: 20 },
];

const LS = [
  { origin: "https://app.example.com", key: "token", value: "TOPSECRET", size: 15 },
  { origin: "https://ads.net", key: "prefs", value: "x", size: 7 },
];

function deps(readCookies = () => SAMPLE) {
  return { os: "linux", home: "/home/bob", exists: () => true, readCookies, readLocalStorage: () => LS };
}

test("parseCommand: cookies ls with flags", () => {
  const c = parseCommand(["cookies", "ls", "--browser", "edge", "--domain", "example.com"]);
  assert.equal(c.command, "cookies");
  assert.equal(c.sub, "ls");
  assert.equal(c.opts.browser, "edge");
  assert.equal(c.opts.domain, "example.com");
});

test("parseCommand: default browser chrome, prune defaults to dry-run", () => {
  assert.equal(parseCommand(["cookies", "ls"]).opts.browser, "chrome");
  assert.equal(parseCommand(["cookies", "prune"]).opts.dryRun, true);
});

test("parseCommand: unknown flag throws", () => {
  assert.throws(() => parseCommand(["cookies", "ls", "--wat"]), /unknown flag/);
});

test("run: no args prints help", async () => {
  const { code, out } = await run([], deps());
  assert.equal(code, 0);
  assert.match(out, /storage-inspect/);
});

test("run: cookies ls filters by domain", async () => {
  let usedPath;
  const d = { ...deps((p) => { usedPath = p; return SAMPLE; }) };
  const { code, out } = await run(["cookies", "ls", "--domain", "example.com"], d);
  assert.equal(code, 0);
  assert.match(out, /sess/);
  assert.match(out, /cart/);
  assert.ok(!out.includes("uid"), "ads.net cookie should be filtered out");
  assert.match(usedPath, /google-chrome\/Default\/Network\/Cookies$/);
});

test("run: falls back to legacy Cookies path when Network layout is absent", async () => {
  let usedPath;
  await run(["cookies", "ls"], {
    os: "linux",
    home: "/home/bob",
    exists: (p) => !p.includes("/Network/"), // only the old layout exists
    readCookies: (p) => { usedPath = p; return []; },
  });
  assert.match(usedPath, /google-chrome\/Default\/Cookies$/);
  assert.ok(!usedPath.includes("/Network/"));
});

test("run: cookies ls --json", async () => {
  const { out } = await run(["cookies", "ls", "--json"], deps());
  assert.equal(JSON.parse(out).length, 3);
});

test("run: cookies ls --json never leaks cookie values", async () => {
  const { out } = await run(["cookies", "ls", "--json"], deps());
  assert.ok(!out.includes("TOPSECRET"), "ls json must not print cookie values");
  assert.equal(JSON.parse(out).every((c) => !("value" in c)), true, "ls json must not carry a value field");
});

test("run: cookies ls (text) never leaks cookie values", async () => {
  const { out } = await run(["cookies", "ls"], deps());
  assert.ok(!out.includes("TOPSECRET"), "ls text must not print cookie values");
});

test("run: cookies du shows totals", async () => {
  const { out } = await run(["cookies", "du"], deps());
  assert.match(out, /\.example.com\s+2/);
  assert.match(out, /total:\s+3 cookies/);
});

test("run: cookies prune is a dry-run report (no writes)", async () => {
  let called = false;
  const { code, out } = await run(["cookies", "prune", "--domain", "ads.net"], {
    ...deps(),
    readCookies: () => SAMPLE,
    deleteCookies: () => { called = true; },
  });
  assert.equal(code, 0);
  assert.match(out, /dry-run/);
  assert.match(out, /ads\.net/);
  assert.equal(called, false, "prune without --force must not delete");
});

test("run: cookies prune --force deletes via deleteCookies", async () => {
  let args;
  const { code, out } = await run(["cookies", "prune", "--domain", "example.com", "--force"], {
    ...deps(),
    readCookies: () => SAMPLE,
    deleteCookies: (path, filter) => {
      args = { path, filter };
      return { deleted: 2, removed: [{ hostKey: ".example.com", name: "sess", size: 9 }, { hostKey: ".example.com", name: "cart", size: 8 }] };
    },
  });
  assert.equal(code, 0);
  assert.match(out, /deleted 2 cookies/);
  assert.equal(args.filter.domain, "example.com");
  assert.match(args.path, /Network\/Cookies$/);
});

test("run: prune output never leaks cookie values", async () => {
  const withValue = [{ hostKey: "a.com", name: "s", value: "TOPSECRET", path: "/", size: 8 }];
  const dry = await run(["cookies", "prune", "--json", "--domain", "a.com"], { ...deps(), readCookies: () => withValue });
  assert.ok(!dry.out.includes("TOPSECRET"), "dry-run json must not contain value");
  const forced = await run(["cookies", "prune", "--json", "--force", "--domain", "a.com"], {
    ...deps(),
    readCookies: () => withValue,
    deleteCookies: () => ({ deleted: 1, removed: [{ hostKey: "a.com", name: "s", size: 8 }] }),
  });
  assert.ok(!forced.out.includes("TOPSECRET"), "force json must not contain value");
});

test("run: browser flag changes resolved path", async () => {
  let usedPath;
  await run(["cookies", "ls", "--browser", "firefox", "--profile", "x.default"], {
    ...deps((p) => { usedPath = p; return []; }),
  });
  assert.match(usedPath, /firefox\/x\.default\/cookies\.sqlite$/);
});

test("run: read error exits 1", async () => {
  const { code, out } = await run(["cookies", "ls"], deps(() => { throw new Error("cannot open cookie store"); }));
  assert.equal(code, 1);
  assert.match(out, /cannot open cookie store/);
});

test("run: usage error exits 2", async () => {
  const { code, out } = await run(["cookies", "bogus"], deps());
  assert.equal(code, 2);
  assert.match(out, /unknown subcommand/);
});

test("run: localstorage ls filters by domain", async () => {
  const { code, out } = await run(["localstorage", "ls", "--domain", "example.com"], deps());
  assert.equal(code, 0);
  assert.match(out, /app\.example.com\s+token/);
  assert.ok(!out.includes("ads.net"), "ads.net origin should be filtered out");
});

test("run: localstorage ls --json omits values", async () => {
  const { code, out } = await run(["localstorage", "ls", "--json"], deps());
  assert.equal(code, 0);
  const arr = JSON.parse(out);
  assert.equal(arr.length, 2);
  assert.ok(!out.includes("TOPSECRET"), "storage output must not leak values");
  assert.deepEqual(Object.keys(arr[0]).sort(), ["key", "origin", "size"]);
});

test("run: localstorage du shows per-origin totals", async () => {
  const { code, out } = await run(["localstorage", "du"], deps());
  assert.equal(code, 0);
  assert.match(out, /https:\/\/app\.example\.com\s+1\s+15 B/);
  assert.match(out, /total:\s+2 entries/);
});

test("run: localstorage reads from the leveldb dir in the profile", async () => {
  let usedDir;
  await run(["localstorage", "ls"], {
    ...deps(),
    readLocalStorage: (dir) => { usedDir = dir; return []; },
  });
  assert.match(usedDir, /google-chrome\/Default\/Local Storage\/leveldb$/);
});

test("run: localstorage unsupported for firefox exits 2", async () => {
  const { code, out } = await run(["localstorage", "ls", "--browser", "firefox", "--profile", "x.default"], deps());
  assert.equal(code, 2);
  assert.match(out, /localStorage is not supported/);
});

test("run: localstorage read error exits 1", async () => {
  const { code, out } = await run(["localstorage", "ls"], {
    ...deps(),
    readLocalStorage: () => { throw new Error("leveldb unreadable"); },
  });
  assert.equal(code, 1);
  assert.match(out, /leveldb unreadable/);
});

test("run: localstorage prune is not a command (usage error exits 2)", async () => {
  const { code, out } = await run(["localstorage", "prune"], deps());
  assert.equal(code, 2);
  assert.match(out, /unknown subcommand/);
});
