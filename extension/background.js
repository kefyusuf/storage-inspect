import { summarize, removeParams } from "./lib/model.js";

const stripLead = (d) => d.replace(/^\./, "");

// chrome.cookies.remove resolves to undefined when it removed nothing, so the
// count of successes has to come from its result, not from the loop.
async function removeEach(cookies) {
  let deleted = 0;
  for (const c of cookies) {
    if (await chrome.cookies.remove(removeParams(c))) deleted += 1;
  }
  return deleted;
}

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
    return { ok: (await chrome.cookies.remove(removeParams(msg.cookie))) !== undefined };
  }

  if (msg.type === "removeDomain") {
    const all = await chrome.cookies.getAll({ domain: stripLead(msg.domain) });
    const namePattern = msg.nameRegex ? new RegExp(msg.nameRegex) : undefined;
    const { matched } = summarize(all, { domain: msg.domain, namePattern });
    return { deleted: await removeEach(matched), wanted: matched.length };
  }

  throw new Error(`unknown message type: ${msg.type}`);
}
