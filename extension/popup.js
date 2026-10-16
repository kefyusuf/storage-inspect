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
  render(res.groups, res.matched);
}

// Group headers show counts/sizes; each cookie row shows host, name, path and a
// delete button. The cookie value is intentionally absent from `matched`.
function render(groups, matched) {
  const byHost = new Map();
  for (const c of matched) {
    const arr = byHost.get(c.hostKey) ?? [];
    arr.push(c);
    byHost.set(c.hostKey, arr);
  }

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
    head.append(delAll);
    li.append(head);

    const ul = document.createElement("ul");
    ul.className = "cookies";
    for (const c of byHost.get(g.hostKey) ?? []) {
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
      del.dataset.hostKey = c.hostKey;
      del.dataset.name = c.name;
      del.dataset.path = c.path;
      del.dataset.secure = String(c.secure);
      del.dataset.storeId = c.storeId;
      row.append(name, path, size, del);
      ul.append(row);
    }
    li.append(ul);
    frag.append(li);
  }

  list.replaceChildren(frag);
  list.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", onClickDelete));
}

async function onClickDelete(e) {
  const btn = e.currentTarget;
  if (btn.textContent === "delete all") {
    const domain = btn.dataset.host.replace(/^\./, "");
    const ok = window.confirm(`Delete every cookie for ${domain}?`);
    if (!ok) return;
    const res = await send({ type: "removeDomain", domain });
    if (res?.error) summary.textContent = res.error;
  } else {
    const cookie = {
      hostKey: btn.dataset.hostKey,
      name: btn.dataset.name,
      path: btn.dataset.path,
      secure: btn.dataset.secure === "true",
      storeId: btn.dataset.storeId,
    };
    await send({ type: "remove", cookie });
  }
  refresh();
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
