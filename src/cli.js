import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProfile } from "./profile.js";
import { filterCookies, groupByDomain, totalSize } from "./filter.js";
import { readLocalStorage, filterLocalStorage, groupStorage } from "./localStorage.js";
import { formatCookies, formatDu, formatStorage, formatStorageDu, humanBytes, safeCookie } from "./report.js";

const HELP = `storage-inspect — inspect browser cookies / localStorage from the terminal

  storage-inspect cookies ls     [filters]
  storage-inspect cookies du     [filters]
  storage-inspect cookies prune  [filters]              (dry-run: shows what would be deleted)
  storage-inspect cookies prune  [filters] --force      (deletes in one transaction; close the browser first)

  storage-inspect localstorage ls [filters]             (chromium only; the write-ahead log tail, .ldb not read)
  storage-inspect localstorage du [filters]             (totals per origin)

Filters / options:
  --browser <chrome|edge|brave|firefox>   default: chrome; firefox: cookies ls/du read, prune and localStorage do not
  --profile <name>                        default: Default (firefox: required)
  --domain <host>                         match entries applying to this host
  --name-regex <pattern>                  filter cookie names (cookies only)
  --json                                  machine-readable output
  --force                                 required for prune to write (delete)

Examples:
  storage-inspect cookies du
  storage-inspect cookies ls --domain example.com
  storage-inspect cookies prune --name-regex '^(_ga|fr)'
  storage-inspect localstorage du --domain example.com`;

const VALUE_FLAGS = { "--browser": "browser", "--profile": "profile", "--domain": "domain", "--name-regex": "nameRegex" };
const BOOL_FLAGS = { "--json": "json", "--dry-run": "dryRun", "--force": "force" };
const COMMANDS = {
  cookies: new Set(["ls", "du", "prune"]),
  localstorage: new Set(["ls", "du"]),
};

export function parseCommand(argv) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return { command: "help" };
  }
  const command = argv[0];
  const subs = COMMANDS[command];
  if (!subs) throw new Error(`unknown command: ${command}`);
  const sub = argv[1];
  if (!sub || !subs.has(sub)) throw new Error(`unknown subcommand: ${sub ?? "(none)"}`);

  const opts = { browser: "chrome", profile: undefined, domain: undefined, nameRegex: undefined, json: false, dryRun: command === "cookies" && sub === "prune", force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a in VALUE_FLAGS) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      opts[VALUE_FLAGS[a]] = v;
    } else if (a in BOOL_FLAGS) {
      opts[BOOL_FLAGS[a]] = true;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return { command, sub, opts };
}

function defaultDeps() {
  return {
    os: process.platform,
    home: homedir(),
    exists: existsSync,
    // node:sqlite is imported only when a cookie store is actually opened, so
    // --help and the localStorage commands still run on a runtime without it.
    readCookies: async (storePath) => (await import("./cookies.js")).readCookieDb(storePath),
    deleteCookies: async (storePath, filters) => (await import("./cookies.js")).deleteCookies(storePath, filters),
    listDir: (dir) => readdirSync(dir),
    readLocalStorage: (dir) =>
      readLocalStorage({
        listFiles: () => readdirSync(dir),
        readFile: (name) => readFileSync(join(dir, name)),
      }),
  };
}

function pickCookiesPath(profile, deps) {
  const candidates = [profile.cookiesPath, profile.legacyCookiesPath].filter(Boolean);
  return candidates.find((p) => deps.exists(p)) ?? profile.cookiesPath;
}

export async function run(argv, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };

  let cmd;
  try {
    cmd = parseCommand(argv);
  } catch (err) {
    return { code: 2, out: `storage-inspect: ${err.message}` };
  }
  if (cmd.command === "help") return { code: 0, out: HELP };

  let profile;
  try {
    profile = resolveProfile({
      browser: cmd.opts.browser,
      os: deps.os,
      home: deps.home,
      profile: cmd.opts.profile,
    });
  } catch (err) {
    return { code: 2, out: `storage-inspect: ${err.message}` };
  }

  return cmd.command === "cookies"
    ? runCookies(cmd, profile, deps)
    : runLocalStorage(cmd, profile, deps);
}

async function runCookies(cmd, profile, deps) {
  // Reading a Gecko store works (the reader picks the table from the file); the
  // write path has not been proven against a real profile yet, so prune refuses
  // rather than half-working.
  if (profile.family === "firefox" && cmd.sub === "prune") {
    return {
      code: 2,
      out: "storage-inspect: pruning a Firefox cookie store is not supported yet — ls and du read it fine.",
    };
  }
  const storePath = pickCookiesPath(profile, deps);
  if (!deps.exists(storePath)) {
    return {
      code: 1,
      out: `storage-inspect: no cookie store at ${storePath} — wrong browser or profile? (firefox profiles look like abc123.default-release)`,
    };
  }
  let cookies;
  try {
    cookies = await deps.readCookies(storePath);
  } catch (err) {
    return { code: 1, out: `storage-inspect: ${err.message}` };
  }

  const matched = filterCookies(cookies, { domain: cmd.opts.domain, namePattern: cmd.opts.nameRegex });

  if (cmd.sub === "ls") {
    return { code: 0, out: formatCookies(matched, { json: cmd.opts.json }) };
  }
  if (cmd.sub === "du") {
    return { code: 0, out: formatDu(groupByDomain(matched), { json: cmd.opts.json }) };
  }

  // prune — dry-run by default; only --force actually deletes (needs browser closed).
  const bytes = totalSize(matched);
  if (!cmd.opts.force) {
    if (cmd.opts.json) {
      const wouldRemove = matched.map(safeCookie);
      return { code: 0, out: JSON.stringify({ dryRun: true, wouldRemove, bytes }, null, 2) };
    }
    const header = `dry-run: would remove ${matched.length} cookies (${humanBytes(bytes)}). Re-run with --force to delete.`;
    return { code: 0, out: [header, formatCookies(matched)].join("\n") };
  }

  let result;
  try {
    result = await deps.deleteCookies(storePath, { domain: cmd.opts.domain, nameRegex: cmd.opts.nameRegex });
  } catch (err) {
    return { code: 1, out: `storage-inspect: ${err.message} (no cookies were deleted)` };
  }
  if (cmd.opts.json) {
    return { code: 0, out: JSON.stringify({ deleted: result.deleted, removed: result.removed }, null, 2) };
  }
  return { code: 0, out: `deleted ${result.deleted} cookies (${humanBytes(totalSize(result.removed))}).` };
}

function runLocalStorage(cmd, profile, deps) {
  if (!profile.localStoragePath) {
    return { code: 2, out: `storage-inspect: localStorage is not supported for ${cmd.opts.browser} (chromium only, best-effort).` };
  }
  let entries;
  try {
    entries = deps.readLocalStorage(profile.localStoragePath);
  } catch (err) {
    return { code: 1, out: `storage-inspect: ${err.message}` };
  }
  const matched = filterLocalStorage(entries, { domain: cmd.opts.domain });

  const out = cmd.sub === "ls"
    ? formatStorage(matched, { json: cmd.opts.json })
    : formatStorageDu(groupStorage(matched), { json: cmd.opts.json });
  if (cmd.opts.json) return { code: 0, out };

  // The WAL only holds recent writes; everything compacted away sits in .ldb
  // files this reader does not parse, so say so instead of looking complete.
  const unread = deps.listDir(profile.localStoragePath).filter((f) => f.endsWith(".ldb")).length;
  const note = unread
    ? `\n\nnote: ${unread} .ldb file(s) here hold compacted data that is not read — this is the write-ahead log tail only.`
    : "";
  return { code: 0, out: out + note };
}
