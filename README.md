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
`engines` alone would not enforce it — npm only prints an `EBADENGINE` warning and installs anyway — so `src/main.js` checks the running version first and exits with 2 and a one-line reason. `--help` and the `localstorage` commands reach that same gate without ever importing `node:sqlite`.
One hole the single floor cannot describe: on Node 23.0.0–23.3.x `node:sqlite` is still behind `--experimental-sqlite`, so a `cookies` command there fails loudly with `storage-inspect: No such built-in module: node:sqlite` (a `localstorage` command still works).
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

storage-inspect localstorage ls [filters]            # Chromium only — compacted *.ldb tables plus the *.log tail
storage-inspect localstorage du [filters]            # totals per origin

  --browser <chrome|edge|brave|firefox>   default: chrome; firefox: cookies ls/du read, prune and localStorage do not
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

Security note: no output (ls/du/prune/localStorage) ever includes a **`value` or `encrypted_value`**; only host/origin, name/key, path, size and the secure/httponly/encrypted flags are printed. The promise is about what leaves the process, not about what SQLite touches: the query asks for `length(value)`, so no column carrying a value is ever returned to JavaScript, printed, or emitted by `--json`. Size is a length sum, not a byte count: SQLite's `length()` returns **characters (code points)** for a TEXT value — so a Firefox cookie whose value contains non-ASCII is reported slightly smaller than it is on disk — and computing it makes SQLite read the whole string into its own memory first (`octet_length()` would count bytes without doing that; it is not used). A localStorage value is measured differently: the LevelDB reader validates the record's format byte and counts the payload's bytes, but never decodes them into a string. `prune --force` is irreversible, so the default is a dry-run and writing requires `--force`.

## Architecture
The pure-logic modules expose a single interface; the CLI and the browser extension share the same modules:
```
src/profile.js       resolveProfile(...)              — modern Chrome path (<profile>/Network/Cookies) + legacyCookiesPath fallback + localStoragePath (Local Storage/leveldb)
src/cookies.js       readCookieDb, deleteCookies      — readOnly SQLite open → copy → "browser running hint"; the store's own `sqlite_master` decides the schema (Chromium `cookies` / Gecko `moz_cookies`) and neither query selects a value column, only `length()` of it; a file with neither table is reported as the wrong file, not as a lock; deleteCookies write-open + rowid DELETE
src/localStorage.js  readLocalStorage, filterLocalStorage, groupStorage — one LevelDB read: the `*.log` tail and the compacted `*.ldb` tables are decoded and merged by sequence number, so the newest write for a key wins and a newer tombstone hides it, whichever side it sits on. Log side: block record reassembly, LEB128 varint, WriteBatch parse (tag byte first, then key and value varstrings, each entry carrying the batch sequence plus its own index), `storage_key\x00` + Blink's one-byte `StorageFormat` (UTF-16LE / Latin-1) before name and value, `META:`/`METAACCESS:` rows skipped; a record whose lengths do not describe it exactly is dropped rather than guessed at; a value is measured, never decoded. A table that cannot be read comes back in `skipped` and is named in a note; a log that cannot be opened is an error, because those writes exist nowhere else.
src/sstable.js       readSstEntries(name, file) — leveldb SSTable (`*.ldb`) read from bytes the caller already holds: footer magic, index handles, prefix-compressed blocks, internal keys split into user key + sequence + value type; Snappy blocks inflated, zstd refused
src/snappy.js        snappyUncompress(buf) — pure Snappy format decoder: varint length preamble, literal and copy tags, copies that overlap the output; every length is checked against the size the stream promised
src/filter.js        filterCookies, groupByDomain, totalSize, cookieSize — pure; shared by CLI and extension
src/report.js        formatCookies, formatDu, formatStorage, formatStorageDu, humanBytes, safeCookie — pure formatting; every output is projected through a field allowlist, so values cannot leak
src/version.js       nodeVersionProblem(version)      — pure floor check, one human-readable reason
src/cli.js           parseCommand, run(argv, deps)    — deps injectable (tests run with fake readCookies/readLocalStorage); the cookie store is imported lazily so `node:sqlite` is loaded only when one is opened
src/main.js          bin entry                        — runs the version gate, then the CLI
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
npm test          # unit + real node:sqlite integration (Chromium and Gecko schemas) + localStorage tables and log tail + end-to-end CLI + extension model/messages/bundle + entry point/version gate + package.json/README consistency
```
Tests never read real browser data: the SQLite integration tests use real `node:sqlite` on temp files, the localStorage test builds synthetic `.log` and `.ldb` bytes, the CLI tests inject `readCookies`/`readLocalStorage`, the entry test runs `src/main.js` in a child process with `node:sqlite` hidden by a loader hook and `process.versions.node` set to an old number, and the extension worker is driven through its `onMessage` listener with a `chrome.cookies` stub. What is left untested is the rendering itself — the popup's DOM (`popup.js`/`popup.html`) and the generated `extension/lib` mirrors are checked as a file graph, not clicked, so a manual pass in a real browser is still owed.

## Out of scope
- **Decrypting values**: Chrome's `encrypted_value` field needs the OS keychain/DPAPI; Firefox stores its values as **plaintext TEXT**, so reading them there would take no work at all — which is exactly why the Gecko query asks SQLite for `length(value)` and never for `value`. This tool is deliberately **read-and-size** only: values are never decrypted, decoded or printed for either browser.
- **Cookie expiry**: neither store selects an expiry column. Chromium writes `expires_utc` as a Windows FILETIME int64 above `Number.MAX_SAFE_INTEGER`, which `node:sqlite` refuses to materialize as a Number, so reading it would break every real profile; Firefox keeps expiry in an `expiry` column that *is* a safe integer, but the tool does not read or print it either, so `--json` omits expiry for both browsers. Showing it means a BigInt read plus FILETIME→date conversion on the Chromium side and a unit conversion on the Gecko side.
- **localStorage coverage**: an origin's data sits in two places in a Chromium LevelDB — compacted `.ldb` SSTables (Snappy-compressed blocks) and the recent writes in the `*.log` tail — and both are read now. They are merged per key by the sequence number each write carries, and a newer deletion hides an older value across that boundary, which is what leveldb itself does when it serves a read. A table this reader cannot use (locked, zstd-compressed, or shaped in a way it will not guess at) is named in a note after the listing instead of failing the command, and the data in it is then missing from the numbers (`--json` stays machine-readable). Two limits remain: which files are live comes from the directory listing, not from the `MANIFEST-*` version log, so a table leveldb abandoned but did not delete could contribute a key it no longer serves; and that note only reaches text output, so a `--json` consumer cannot tell a complete store from a partial one.
- **localStorage deletion**: reading is best-effort (see above); no deletion is performed.
- **Firefox deletion**: Gecko keeps cookies in a `moz_cookies` table, which the reader now detects from the file's own schema (`sqlite_master`) and reads with the same length-only queries, so `cookies ls`/`du` work on a Firefox profile — with `--profile <profile-name>` required, since Firefox names profiles itself. `cookies prune` refuses: the write path has not been proven against a real Firefox store, and a delete is not a place to guess.
- **Firefox session cookies**: a Firefox count is a count of *persisted* cookies. `CookiePersistentStorage::StoreCookie()` returns early when `aCookie->IsSession()`, so a session cookie lives only in memory and never reaches `cookies.sqlite` — what `ls`/`du` list is what was written to disk, not everything a page currently holds. Chromium is different: it persists session cookies too — its store has rows with `has_expires = 0` and `is_persistent = 0` — so its counts include them.
- **Firefox localStorage**: the reader parses a Chromium LevelDB — its compacted tables and its log tail — and a Firefox profile is not that, so `localstorage` reports "not supported for firefox" instead of guessing at a different backend.

## If `cookies` returns `EBUSY` while the browser is open
On Windows a running Chromium browser locks its `Cookies` file against sharing, so both attempts fail: the read-only open reports `unable to open database file` and the copy fallback reports `EBUSY: resource busy or locked`. The copy still helps on systems where the file is copyable but SQLite refuses the open, not here — closing the browser is the only reliable fix. Background processes keep the lock too, so all of them must go:
```
taskkill /IM chrome.exe /F          # Windows
```
`localstorage` is not affected: Chromium shares its LevelDB files, so `localstorage ls` and `du` read a live profile — the `*.ldb` tables are opened in place along with the `*.log` tail.

Firefox is a different case: `cookies.sqlite` is a WAL-mode file, and reading it read-only worked here with Firefox itself running — try a live profile before closing anything. It is not a guarantee: a read-only WAL open still needs SQLite to reach `-wal` and `-shm`, and if that fails on Windows the same lock logic as Chromium applies, so closing Firefox is the fix.
