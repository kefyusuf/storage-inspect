const BROWSERS = {
  chrome: {
    family: "chromium",
    cookieFile: "Cookies",
    roots: {
      win32: ["AppData", "Local", "Google", "Chrome", "User Data"],
      darwin: ["Library", "Application Support", "Google", "Chrome"],
      linux: [".config", "google-chrome"],
    },
  },
  edge: {
    family: "chromium",
    cookieFile: "Cookies",
    roots: {
      win32: ["AppData", "Local", "Microsoft", "Edge", "User Data"],
      darwin: ["Library", "Application Support", "Microsoft Edge"],
      linux: [".config", "microsoft-edge"],
    },
  },
  brave: {
    family: "chromium",
    cookieFile: "Cookies",
    roots: {
      win32: ["AppData", "Roaming", "BraveSoftware", "Brave-Browser", "User Data"],
      darwin: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
      linux: [".config", "BraveSoftware", "Brave-Browser"],
    },
  },
  firefox: {
    family: "firefox",
    cookieFile: "cookies.sqlite",
    roots: {
      win32: ["AppData", "Roaming", "Mozilla", "Firefox", "Profiles"],
      darwin: ["Library", "Application Support", "Firefox", "Profiles"],
      linux: [".mozilla", "firefox"],
    },
  },
};

function join(...parts) {
  return parts.flat().join("/").replace(/\/{2,}/g, "/");
}

export function resolveProfile({ browser = "chrome", os, home, profile } = {}) {
  const cfg = BROWSERS[browser];
  if (!cfg) throw new Error(`unsupported browser: ${browser}`);
  const root = cfg.roots[os];
  if (!root) throw new Error(`unsupported os: ${os}`);

  const base = home.replace(/\/+$/, "");

  if (cfg.family === "firefox") {
    if (!profile) throw new Error("profile is required for firefox (e.g. abc123.default-release)");
    return {
      browser,
      family: "firefox",
      profile,
      cookiesPath: join(base, ...root, profile, cfg.cookieFile),
      localStoragePath: undefined,
    };
  }

  const prof = profile || "Default";
  return {
    browser,
    family: "chromium",
    profile: prof,
    // Modern Chrome/Edge/Brave keep cookies under <profile>/Network/Cookies.
    cookiesPath: join(base, ...root, prof, "Network", cfg.cookieFile),
    // Older builds used <profile>/Cookies — used as a fallback.
    legacyCookiesPath: join(base, ...root, prof, cfg.cookieFile),
    localStoragePath: join(base, ...root, prof, "Local Storage", "leveldb"),
  };
}
