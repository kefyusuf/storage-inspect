export function cookieSize(cookie) {
  if (typeof cookie.size === "number") return cookie.size;
  return (cookie.name?.length ?? 0) + (cookie.value?.length ?? 0);
}

function stripDot(host) {
  return host.startsWith(".") ? host.slice(1) : host;
}

function hostMatches(hostKey, domain) {
  if (hostKey.startsWith(".")) {
    const base = hostKey.slice(1);
    return domain === base || domain.endsWith(`.${base}`);
  }
  return domain === hostKey; // host-only cookies match the exact host
}

function makeMatcher(pattern) {
  if (pattern == null) return () => true;
  if (pattern instanceof RegExp) return (name) => pattern.test(name);
  const re = new RegExp(pattern);
  return (name) => re.test(name);
}

export function filterCookies(cookies, { domain, namePattern } = {}) {
  const matchesName = makeMatcher(namePattern);
  const target = domain ? stripDot(domain) : null;
  return cookies.filter(
    (c) => (target === null || hostMatches(c.hostKey, target)) && matchesName(c.name),
  );
}

export function totalSize(cookies) {
  return cookies.reduce((sum, c) => sum + cookieSize(c), 0);
}

export function groupByDomain(cookies) {
  const map = new Map();
  for (const c of cookies) {
    const g = map.get(c.hostKey) ?? { hostKey: c.hostKey, count: 0, size: 0 };
    g.count += 1;
    g.size += cookieSize(c);
    map.set(c.hostKey, g);
  }
  return [...map.values()].sort((a, b) => b.size - a.size);
}
