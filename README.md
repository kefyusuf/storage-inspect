# storage-inspect

![CI](https://github.com/kefyusuf/storage-inspect/actions/workflows/ci.yml/badge.svg)
![node](https://img.shields.io/badge/node-%E2%89%A522.18.0-brightgreen)
![deps](https://img.shields.io/badge/dependencies-0-blue)

A dependency-free Node CLI to inspect browser cookies and localStorage — plus a Manifest V3 browser extension.

## Why
See which sites are hoarding how many cookies, and find the domains you want to clear — but do it without opening a browser, in a scriptable way, and without ever leaking values. Portfolio piece: JavaScript fundamentals + TDD practice (every module is a pure function with its own test).

## Install
Node 22.18.0+ is enough (`node:sqlite` is built in). No `npm install` needed.
That floor is load-bearing: older Node ignores the `readOnly` option that `node:sqlite` uses, so reading a running browser's cookie store would open it for writing instead.
```
cd storage-inspect
npm link         # optional: then `storage-inspect ...` works from anywhere
```

## Usage
```
storage-inspect cookies ls    [filters]
storage-inspect cookies du    [filters]
storage-inspect cookies prune [filters]              # dry-run: shows what would be deleted, deletes nothing
storage-inspect cookies prune [filters] --force      # deletes in one SQLite transaction — browser must be closed

storage-inspect localstorage ls [filters]            # Chromium only — the write-ahead log (*.log) tail
storage-inspect localstorage du [filters]            # totals per origin (compacted .ldb not read)

  --browser <chrome|edge|brave|firefox>   default: chrome; firefox stores are not readable yet
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
```

Security note: no output (ls/du/prune/localStorage) ever includes a **`value` or `encrypted_value`**; only host/origin, name/key, path, size (bytes) and the secure/httponly/encrypted flags are printed. A localStorage value is not even read into memory: the LevelDB reader checks its format byte and measures its length, never its text. `prune --force` is irreversible, so the default is a dry-run and writing requires `--force`.

## Architecture
The pure-logic modules expose a single interface; the CLI and the browser extension share the same modules:
```
src/profile.js       resolveProfile(...)              — modern Chrome path (<profile>/Network/Cookies) + legacyCookiesPath fallback + localStoragePath (Local Storage/leveldb)
src/cookies.js       readCookieDb, deleteCookies      — readOnly SQLite open → copy → "browser running hint"; SQL returns name/path plus `length()` of value & encrypted_value, never their contents; deleteCookies write-open + rowid DELETE
src/localStorage.js  readLocalStorage, filterLocalStorage, groupStorage — LevelDB WAL (.log): block record reassembly, LEB128 varint, WriteBatch parse (tag byte first, then key and value varstrings, `kTypeDeletion` tombstones honoured), `storage_key\x00` + Blink's one-byte `StorageFormat` (UTF-16LE / Latin-1) before name and value, last-write-wins, `META:`/`METAACCESS:` rows skipped; a record whose lengths do not describe it exactly is dropped rather than guessed at; a value is measured, never decoded
src/filter.js        filterCookies, groupByDomain, totalSize, cookieSize — pure; shared by CLI and extension
src/report.js        formatCookies, formatDu, formatStorage, formatStorageDu, humanBytes, safeCookie — pure formatting; every output is projected through a field allowlist, so values cannot leak
src/cli.js           parseCommand, run(argv, deps)    — deps injectable (tests run with fake readCookies/readLocalStorage)
```

## Browser extension (Manifest V3)
Under `extension/` there is an MV3 extension for DOM-based visual inspection plus per-cookie and per-host-group deletion. It reuses the pure logic from `src/filter.js` and `src/report.js`.

Because an extension can only import files inside its own folder, the shared modules are copied into `extension/lib/` (the single source of truth stays in `src/`):
```
npm run build:extension      # src/filter.js, src/report.js → extension/lib/
```
Load it via `chrome://extensions` → Developer mode → "Load unpacked" → select the `extension/` folder. The popup filters by domain/name-regex, groups by host, and deletes through the `chrome.cookies` API; values are never shown. A group's "delete all" removes exactly the rows that group listed, under the filter they were listed with.
```
extension/manifest.json       MV3 — permissions: cookies, host_permissions: <all_urls>
extension/background.js       service worker (module) — ls / remove / removeGroup messages
extension/popup.{html,js,css} inputs + per-host groups + delete buttons
extension/lib/model.js        toInternal (strips value), summarize, removeUrl, removeParams, filterByHostKey — pure, tested core
```

## Test
```
npm test          # 139 tests — unit + real node:sqlite integration + localStorage WAL + end-to-end CLI + extension model/messages/bundle + package.json/README consistency
```
Tests never read real browser data: the SQLite integration tests use real `node:sqlite` on temp files, the localStorage test builds synthetic `.log` bytes, the CLI tests inject `readCookies`/`readLocalStorage`/`listDir`, and the extension worker is driven through its `onMessage` listener with a `chrome.cookies` stub. What is left untested is the rendering itself — the popup's DOM (`popup.js`/`popup.html`) and the generated `extension/lib` mirrors are checked as a file graph, not clicked, so a manual pass in a real browser is still owed.

## Out of scope
- **Decrypting values**: Chrome's `encrypted_value` field needs the OS keychain/DPAPI; this tool is deliberately **read-and-size** only — values are never decrypted or printed.
- **Cookie expiry**: Chromium writes `expires_utc` as a Windows FILETIME int64 above `Number.MAX_SAFE_INTEGER`, which `node:sqlite` refuses to materialize as a Number, so the reader never selects that column and `--json` omits it. Showing it needs a BigInt read plus a FILETIME→date conversion.
- **localStorage coverage**: only the write-ahead log (`*.log`) is parsed. Once LevelDB compacts, the bulk of an origin's data lives in `.ldb` SSTables (Snappy-compressed blocks), which this reader does not open, so the entries listed are the recent-write tail — often a small fraction of what the origin actually holds. The text output of `ls`/`du` says how many `.ldb` files were left unread (`--json` stays machine-readable).
- **localStorage deletion**: reading is best-effort and partial (see above); no deletion is performed.
- **Firefox**: Gecko stores cookies in a `moz_cookies` table and keeps localStorage in a different backend, so neither `cookies` nor `localstorage` reads a Firefox profile — the profile path resolves, the command exits with "not supported yet".

## If `cookies` returns `EBUSY` while the browser is open
On Windows a running Chromium browser locks its `Cookies` file against sharing, so both attempts fail: the read-only open reports `unable to open database file` and the copy fallback reports `EBUSY: resource busy or locked`. The copy still helps on systems where the file is copyable but SQLite refuses the open, not here — closing the browser is the only reliable fix. Background processes keep the lock too, so all of them must go:
```
taskkill /IM chrome.exe /F          # Windows
```
`localstorage` is not affected: Chromium shares its LevelDB write-ahead log, so `localstorage ls` and `du` read a live profile.
