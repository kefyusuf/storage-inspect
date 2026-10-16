# storage-inspect

![CI](https://github.com/kefyusuf/storage-inspect/actions/workflows/ci.yml/badge.svg)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![deps](https://img.shields.io/badge/dependencies-0-blue)

A dependency-free Node CLI to inspect browser cookies and localStorage — plus a Manifest V3 browser extension.

## Why
See which sites are hoarding how many cookies, and find the domains you want to clear — but do it without opening a browser, in a scriptable way, and without ever leaking values. Portfolio piece: JavaScript fundamentals + TDD practice (every module is a pure function with its own test).

## Install
Node 22+ is enough (`node:sqlite` is built in). No `npm install` needed.
```
cd storage-inspect
npm link         # optional: then `storage-inspect ...` works from anywhere
```

## Usage
```
storage-inspect cookies ls    [filters]
storage-inspect cookies du    [filters]
storage-inspect cookies prune [filters]              # dry-run: shows what would be deleted, deletes nothing
storage-inspect cookies prune [filters] --force      # actually deletes (SQLite write) — browser must be closed

storage-inspect localstorage ls [filters]            # Chromium only, best-effort (leveldb .log reader)
storage-inspect localstorage du [filters]            # totals per origin

  --browser <chrome|edge|brave|firefox>   default: chrome
  --profile <name>                        default: Default (firefox: required)
  --domain  <host>                        limit to entries applying to this host
                                          (".example.com" → apex + subdomains;
                                           "example.com" host-only → apex only)
  --name-regex <pattern>                  filter cookie names by regex (cookies only)
  --json                                  machine-readable output
  --force                                 required for prune to actually delete
```

Examples:
```
storage-inspect cookies du
storage-inspect cookies ls --domain google.com
storage-inspect cookies prune --name-regex '^(_ga|fr)'
storage-inspect cookies prune --domain ads.net --force
storage-inspect localstorage du --domain example.com
storage-inspect cookies du --browser firefox --profile x.default-release --json
```

Security note: no output (ls/du/prune/localStorage) ever includes a **`value` or `encrypted_value`**; only host/origin, name/key, path and size (bytes) are printed. `prune --force` is irreversible, so the default is a dry-run and writing requires `--force`.

## Architecture
The pure-logic modules expose a single interface; the CLI and the browser extension share the same modules:
```
src/profile.js       resolveProfile(...)              — modern Chrome path (<profile>/Network/Cookies) + legacyCookiesPath fallback + localStoragePath (Local Storage/leveldb)
src/cookies.js       readCookieDb, deleteCookies      — readOnly SQLite open → copy → "browser running hint"; SQL returns name/path plus `length()` of value & encrypted_value, never their contents; deleteCookies write-open + rowid DELETE
src/localStorage.js  readLocalStorage, filterLocalStorage, groupStorage — LevelDB WAL (.log): block record reassembly, LEB128 varint, WriteBatch parse, origin\x00key UTF-16LE, last-write-wins, META rows skipped
src/filter.js        filterCookies, groupByDomain, totalSize, cookieSize — pure; shared by CLI and extension
src/report.js        formatCookies, formatDu, formatStorage, formatStorageDu, humanBytes, safeCookie — pure formatting; every output is projected through a field allowlist, so values cannot leak
src/cli.js           parseCommand, run(argv, deps)    — deps injectable (tests run with fake readCookies/readLocalStorage)
```

## Browser extension (Manifest V3)
Under `extension/` there is an MV3 extension for DOM-based visual inspection plus per-cookie / whole-domain deletion. It reuses the pure logic from `src/filter.js` and `src/report.js`.

Because an extension can only import files inside its own folder, the shared modules are copied into `extension/lib/` (the single source of truth stays in `src/`):
```
npm run build:extension      # src/filter.js, src/report.js → extension/lib/
```
Load it via `chrome://extensions` → Developer mode → "Load unpacked" → select the `extension/` folder. The popup filters by domain/name-regex, groups by host, and deletes through the `chrome.cookies` API; values are never shown.
```
extension/manifest.json       MV3 — permissions: cookies, host_permissions: <all_urls>
extension/background.js       service worker (module) — ls / remove / removeDomain messages
extension/popup.{html,js,css} inputs + per-host groups + delete buttons
extension/lib/model.js        toInternal (strips value), summarize, removeUrl — pure, tested core
```

## Test
```
npm test          # 93 tests — unit + real node:sqlite integration + localStorage WAL + end-to-end CLI + extension model
```
Tests never read real browser data: the SQLite integration tests use real `node:sqlite` on temp files, the localStorage test builds synthetic `.log` bytes, and the CLI tests inject `readCookies`/`readLocalStorage`. The extension's UI is not tested; its chrome-cookie transform/grouping core (`extension/lib/model.js`) is.

## Out of scope
- **Decrypting values**: Chrome's `encrypted_value` field needs the OS keychain/DPAPI; this tool is deliberately **read-and-size** only — values are never decrypted or printed.
- **localStorage deletion**: the leveldb read is best-effort (only `.log` records, not `.ldb` SSTables); no deletion is performed.
- **Firefox localStorage**: Gecko uses a different format; both the CLI and the extension support localStorage on Chromium only.

## If `du` returns `EBUSY` while the browser is open
`storage-inspect` first tries to open the store directly read-only, then falls back to copying it; if both fail, the error says "close the browser and retry". You may also need to kill Chrome's background processes:
```
taskkill /IM chrome.exe /F          # Windows
```
