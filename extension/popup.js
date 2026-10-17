import { humanBytes } from "./lib/report.js";

const $ = (id) => document.getElementById(id);
const list = $("list");
const summary = $("summary");

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function setBusy(on) {
  $("refresh").disabled = on;
  summary.textContent = on ? "reading…" : summary.textContent;
}

async function refresh() {
  const domain = $("domain").value.trim();
  const nameRegex = $("nameRegex").value.trim();
  setBusy(true);
  let res;
  try {
    res = await send({ type: "ls", domain: domain || undefined, nameRegex: nameRegex || undefined });
  } finally {
    setBusy(false);
  }
  if (res?.error) {
    summary.textContent = res.error;
    list.replaceChildren();
    return;
  }
  summary.textContent = `${res.count} cookies · ${humanBytes(res.bytes)}${domain ? ` · ${domain}` : " · all domains"}`;
  // Remember what the list actually is, so a later delete addresses the rows and
  // the name filter the user saw instead of the values now in the input boxes.
  view = { cookies: res.matched, nameRegex: nameRegex || undefined };
  render(res.groups, res.matched);
}

// Group headers show counts/sizes; each cookie row shows host, name, path and a
// delete button. The cookie value is intentionally absent from `matched`.
// The delete buttons carry only the index into `view.cookies`, so a removal
// addresses the cookie exactly as it was listed — partition key included.
let view = { cookies: [], nameRegex: undefined };

function render(groups, matched) {
  const byHost = new Map();
  matched.forEach((c, i) => {
    const arr = byHost.get(c.hostKey) ?? [];
    arr.push(i);
    byHost.set(c.hostKey, arr);
  });

  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const li = document.createElement("li");

    const head = document.createElement("div");
    head.className = "host";
    const title = document.createElement("strong");
    title.textContent = g.hostKey;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${g.count} · ${humanBytes(g.size)}`;
    head.append(title, meta);
    const delAll = document.createElement("button");
    delAll.className = "ghost danger";
    delAll.textContent = "delete all";
    delAll.dataset.host = g.hostKey;
    delAll.dataset.count = String(g.count);
    head.append(delAll);
    li.append(head);

    const ul = document.createElement("ul");
    ul.className = "cookies";
    for (const i of byHost.get(g.hostKey) ?? []) {
      const c = matched[i];
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = c.name;
      const path = document.createElement("span");
      path.className = "path";
      path.textContent = c.path;
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = humanBytes(c.size);
      const del = document.createElement("button");
      del.className = "ghost";
      del.textContent = "×";
      del.dataset.index = String(i);
      row.append(name, path, size, del);
      ul.append(row);
    }
    li.append(ul);
    frag.append(li);
  }

  list.replaceChildren(frag);
  list.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", onClickDelete));
}

// The list is refreshed first, then the result is written over it: a removal
// that the store refused has to stay on screen instead of being hidden by the
// new counts.
async function onClickDelete(e) {
  const btn = e.currentTarget;
  if (btn.textContent === "delete all") {
    const hostKey = btn.dataset.host;
    if (!window.confirm(`Delete the ${btn.dataset.count} cookies listed for ${hostKey}?`)) return;
    const res = await send({ type: "removeGroup", hostKey, nameRegex: view.nameRegex });
    await refresh();
    if (res?.error) summary.textContent = res.error;
    else if (res && res.deleted !== res.wanted) summary.textContent = `removed ${res.deleted} of ${res.wanted} on ${hostKey}`;
    return;
  }

  const cookie = view.cookies[Number(btn.dataset.index)];
  const res = await send({ type: "remove", cookie });
  await refresh();
  if (res?.error) summary.textContent = res.error;
  else if (res && !res.ok) summary.textContent = `could not remove ${cookie.name} on ${cookie.hostKey}`;
}

$("controls").addEventListener("submit", (e) => {
  e.preventDefault();
  refresh();
});
$("clear").addEventListener("click", () => {
  $("domain").value = "";
  refresh();
});

refresh();
