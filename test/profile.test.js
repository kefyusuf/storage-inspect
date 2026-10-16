import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../src/profile.js";

const win = (o) => resolveProfile({ browser: "chrome", os: "win32", home: "C:/Users/bob", ...o });

test("chrome windows cookie path", () => {
  assert.equal(
    win().cookiesPath,
    "C:/Users/bob/AppData/Local/Google/Chrome/User Data/Default/Network/Cookies",
  );
});

test("chrome linux cookie path", () => {
  assert.equal(
    resolveProfile({ browser: "chrome", os: "linux", home: "/home/bob" }).cookiesPath,
    "/home/bob/.config/google-chrome/Default/Network/Cookies",
  );
});

test("chrome mac cookie path", () => {
  assert.equal(
    resolveProfile({ browser: "chrome", os: "darwin", home: "/Users/bob" }).cookiesPath,
    "/Users/bob/Library/Application Support/Google/Chrome/Default/Network/Cookies",
  );
});

test("edge linux uses microsoft-edge", () => {
  assert.equal(
    resolveProfile({ browser: "edge", os: "linux", home: "/h" }).cookiesPath,
    "/h/.config/microsoft-edge/Default/Network/Cookies",
  );
});

test("brave windows uses Roaming and User Data", () => {
  assert.equal(
    resolveProfile({ browser: "brave", os: "win32", home: "C:/U/b" }).cookiesPath,
    "C:/U/b/AppData/Roaming/BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies",
  );
});

test("profile override is respected", () => {
  assert.equal(
    win({ profile: "Profile 1" }).cookiesPath,
    "C:/Users/bob/AppData/Local/Google/Chrome/User Data/Profile 1/Network/Cookies",
  );
});

test("localStorage leveldb dir for chromium", () => {
  assert.equal(
    win().localStoragePath,
    "C:/Users/bob/AppData/Local/Google/Chrome/User Data/Default/Local Storage/leveldb",
  );
});

test("exposes a legacy Cookies path fallback (pre-Network layout)", () => {
  const r = win();
  assert.equal(r.cookiesPath, "C:/Users/bob/AppData/Local/Google/Chrome/User Data/Default/Network/Cookies");
  assert.equal(r.legacyCookiesPath, "C:/Users/bob/AppData/Local/Google/Chrome/User Data/Default/Cookies");
});

test("firefox has no legacy fallback and no localStorage dir", () => {
  const r = resolveProfile({ browser: "firefox", os: "linux", home: "/h", profile: "x.default" });
  assert.equal(r.legacyCookiesPath, undefined);
  assert.equal(r.localStoragePath, undefined);
});

test("trailing slash in home is normalized", () => {
  assert.equal(
    resolveProfile({ browser: "chrome", os: "linux", home: "/home/bob/" }).cookiesPath,
    "/home/bob/.config/google-chrome/Default/Network/Cookies",
  );
});

test("firefox windows needs an explicit profile, cookies.sqlite", () => {
  const r = resolveProfile({
    browser: "firefox", os: "win32", home: "C:/Users/bob", profile: "abc123.default-release",
  });
  assert.equal(
    r.cookiesPath,
    "C:/Users/bob/AppData/Roaming/Mozilla/Firefox/Profiles/abc123.default-release/cookies.sqlite",
  );
});

test("firefox without profile throws", () => {
  assert.throws(
    () => resolveProfile({ browser: "firefox", os: "linux", home: "/h" }),
    /profile is required for firefox/,
  );
});

test("unknown browser throws", () => {
  assert.throws(() => resolveProfile({ browser: "safari", os: "linux", home: "/h" }), /unsupported browser/);
});

test("unknown os throws", () => {
  assert.throws(() => resolveProfile({ browser: "chrome", os: "freebsd", home: "/h" }), /unsupported os/);
});
