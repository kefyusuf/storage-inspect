import { summarize, removeUrl } from "./lib/model.js";

const stripLead = (d) => d.replace(/^\./, "");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message ?? err) }));
  return true; // keep the message channel open for the async reply
});

async function handle(msg) {
  if (msg.type === "ls") {
    const all = await chrome.cookies.getAll(msg.domain ? { domain: stripLead(msg.domain) } : {});
    const namePattern = msg.nameRegex ? new RegExp(msg.nameRegex) : undefined;
    const { matched, groups, bytes } = summarize(all, { domain: msg.domain, namePattern });
    return { matched, groups, bytes, count: matched.length };
  }

  if (msg.type === "remove") {
    const c = msg.cookie;
    await chrome.cookies.remove({ url: removeUrl(c), name: c.name, storeId: c.storeId });
    return { ok: true };
  }

  if (msg.type === "removeDomain") {
    const all = await chrome.cookies.getAll({ domain: stripLead(msg.domain) });
    const namePattern = msg.nameRegex ? new RegExp(msg.nameRegex) : undefined;
    const { matched } = summarize(all, { domain: msg.domain, namePattern });
    let deleted = 0;
    for (const c of matched) {
      await chrome.cookies.remove({ url: removeUrl(c), name: c.name, storeId: c.storeId });
      deleted += 1;
    }
    return { deleted };
  }

  throw new Error(`unknown message type: ${msg.type}`);
}
