import { filterCookies, groupByDomain, totalSize } from "./filter.js";

// Chrome hands us cookie objects with a `value`; the extension must never carry
// that value into the UI, so we project to a safe shape keeping only its length.
export function toInternal(cookie) {
  return {
    hostKey: cookie.domain,
    name: cookie.name,
    path: cookie.path || "/",
    size: (cookie.name?.length ?? 0) + (cookie.value?.length ?? 0),
    secure: cookie.secure ?? false,
    storeId: cookie.storeId,
  };
}

export function summarize(chromeCookies, { domain, namePattern } = {}) {
  const internal = chromeCookies.map(toInternal);
  const matched = filterCookies(internal, { domain, namePattern });
  return { matched, groups: groupByDomain(matched), bytes: totalSize(matched) };
}

// chrome.cookies.remove needs a creation URL; reconstruct it from safe fields.
export function removeUrl(cookie) {
  const scheme = cookie.secure ? "https" : "http";
  const host = (cookie.hostKey || "").replace(/^\./, "");
  return `${scheme}://${host}${cookie.path || "/"}`;
}
