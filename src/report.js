"use strict";

// Report page: src/report.html?host=<host>&owner=<owner>&repo=<repo>.
// Lists branches, filters and sorts them, exports them, and deletes or restores branches.
// Data logic is in report-data.js (CpReport). This file has only the UI.
const L = globalThis.CpLib;
const A = globalThis.CpAuth;
const $ = (id) => document.getElementById(id);
const NAME_RE = /^[A-Za-z0-9._-]+$/;

const CHIPS = [
  ["all", "All"],
  ["no-pr", "No PR"],
  ["open", "Open PR"],
  ["merged", "Merged PR"],
  ["closed", "Closed PR (not merged)"],
  ["merged-no-pr", "Merged without PR"],
  ["stale", "Stale"]
];

const REASONS = {
  default: "Default branch. You cannot delete it.",
  protected: "Protected branch. You cannot delete it.",
  "no-permission": "You do not have write access to this repository."
};

const CREATOR_SOURCES = {
  pr: "Estimated: author of the pull request.",
  "first-commit": "Estimated: author of the first commit that is not on the default branch.",
  none: "Unknown. No pull request and no own commits."
};

const DELETE_STATUS = {
  deleted: ["Deleted", "ok"],
  changed: ["Not deleted: changed since the report", "warn-text"],
  gone: ["Already gone", "muted"],
  failed: ["Failed", "error"]
};

const RESTORE_STATUS = {
  restored: ["Restored", "ok"],
  exists: ["Already exists", "muted"],
  invalid: ["Not valid", "error"],
  failed: ["Failed", "error"]
};

const state = {
  host: null,
  owner: null,
  repo: null,
  session: null,
  client: null,
  report: null,
  view: null,
  loading: false,
  loadSeq: 0,
  filter: { status: "all", search: "", creator: "" },
  sort: { key: "date", dir: "desc" },
  selected: new Set(),
  visible: []
};

// ---- Small helpers ----

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k in node && k !== "list") node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function errText(err) {
  return String((err && err.message) || err);
}

function repoFull() {
  return `${state.owner}/${state.repo}`;
}

function webRepo() {
  return `${L.webBase(state.host)}/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}`;
}

// Branch names can have "/". Encode each part, keep the "/".
function branchUrl(name) {
  return `${webRepo()}/tree/${String(name).split("/").map(encodeURIComponent).join("/")}`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + "s"}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateStamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function timeStamp(d) {
  return `${dateStamp(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];

function relTime(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = (t - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(s) >= size) return RTF.format(Math.round(s / size), unit);
  }
  return "just now";
}

function exactTime(iso) {
  const t = Date.parse(iso);
  return t ? new Date(t).toLocaleString() : "";
}

function shortSha(sha) {
  return String(sha || "").slice(0, 7);
}

// openPrs has all open PRs. The newest PR (row.pr) can be closed while an older one is open.
function openPrList(row) {
  if (Array.isArray(row.openPrs)) return row.openPrs;
  return row.pr && row.pr.state === "OPEN" ? [row.pr.number] : [];
}

function isOpenPr(row) {
  return openPrList(row).length > 0;
}

function canSelect(row) {
  return !!(row.deletable && row.deletable.ok);
}

// Rows that "select all" may select. Open PRs are never selected automatically.
function autoSelectable(row) {
  return canSelect(row) && !isOpenPr(row);
}

function creatorKey(row) {
  const c = row.probableCreator || {};
  return c.login || c.name || "";
}

function committerText(row) {
  const c = row.lastCommit || {};
  return c.login || c.authorName || "";
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name, hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function setStatus(node, text, kind) {
  node.textContent = text;
  node.classList.toggle("error", kind === "error");
  node.classList.toggle("ok", kind === "ok");
}

function report() {
  return globalThis.CpReport;
}

// ---- Views ----

function show(view) {
  state.view = view;
  for (const id of ["badView", "loginView", "loadView", "errorView", "reportView"]) $(id).hidden = id !== view;
  $("reload").hidden = view === "badView" || view === "loginView";
}

function openSettings(e) {
  if (e) e.preventDefault();
  chrome.runtime.openOptionsPage();
}

function openLogin() {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/login.html?host=${encodeURIComponent(state.host)}`) });
}

function showLogin(text) {
  $("loginTitle").textContent = `Log in to ${state.host}`;
  $("loginText").textContent = text ||
    `The report reads the branches with your GitHub account on ${state.host}. The token stays in this browser.`;
  show("loginView");
}

// ---- Start ----

function readParams() {
  const q = new URLSearchParams(location.search);
  const host = L.normalizeHost(q.get("host") || "");
  const owner = String(q.get("owner") || "");
  const repo = String(q.get("repo") || "");
  if (!host || !NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  return { host, owner, repo };
}

async function start() {
  const p = readParams();
  $("settingsLink").addEventListener("click", openSettings);
  if (!p) {
    show("badView");
    return;
  }
  Object.assign(state, p);
  document.title = `Branches · ${repoFull()}`;
  const title = $("title");
  title.replaceChildren("Branches · ", el("a", { href: webRepo(), target: "_blank", rel: "noopener", text: repoFull() }));
  $("meta").textContent = state.host;

  buildChips();
  bindEvents();
  await checkSession();
}

// Loads the report when a session exists. Else shows the login view.
async function checkSession() {
  const session = await A.getSession(state.host);
  if (!session) {
    state.session = null;
    state.client = null;
    if (state.view !== "loginView") showLogin();
    return;
  }
  const changed = !state.session || state.session.token !== session.token;
  state.session = session;
  state.client = globalThis.CpApi.createClient({
    apiBase: L.apiBase(state.host),
    graphqlUrl: L.graphqlUrl(state.host),
    token: session.token
  });
  if (changed || state.view === "loginView" || !state.view) await load();
}

// ---- Load ----

function progressText(p) {
  const done = Number(p.done) || 0;
  const total = Number(p.total) || 0;
  if (!done && !total) return p.phase === "details" ? "Checking branches…" : "Reading branches…";
  const count = total ? `${done}/${total}` : String(done);
  return p.phase === "details" ? `Checking ${count} branches…` : `Reading branches ${count}…`;
}

function setProgress(p) {
  const text = progressText(p);
  const total = Number(p.total) || 0;
  const bar = $("progressBar");
  if (total) {
    bar.max = total;
    bar.value = Math.min(Number(p.done) || 0, total);
  } else {
    bar.removeAttribute("value");
  }
  $("progressText").textContent = text;
  if (state.view === "reportView") setStatus($("toolStatus"), text);
}

async function load() {
  const R = report();
  if (!R || typeof R.loadReport !== "function") {
    showError(new Error("The report module (report-data.js) is missing. Reinstall the extension."));
    return;
  }
  if (!state.client) return checkSession();
  const seq = ++state.loadSeq;
  state.loading = true;
  updateToolbar();
  $("reload").disabled = true;
  // Keep an old report on the screen while the new one loads.
  if (state.view !== "reportView") show("loadView");
  setProgress({ phase: "branches", done: 0, total: 0 });
  try {
    const { staleDays } = await A.getSettings();
    const rep = await R.loadReport(state.client, { owner: state.owner, repo: state.repo, staleDays },
      (p) => { if (seq === state.loadSeq) setProgress(p); });
    if (seq !== state.loadSeq) return;
    state.report = rep;
    const names = new Set(rep.branches.map((r) => r.name));
    for (const n of state.selected) {
      const row = rep.branches.find((r) => r.name === n);
      if (!names.has(n) || !row || !canSelect(row)) state.selected.delete(n);
    }
    setStatus($("toolStatus"), "");
    show("reportView");
    renderReport();
  } catch (err) {
    if (seq !== state.loadSeq) return;
    console.error(err);
    await showError(err);
  } finally {
    if (seq === state.loadSeq) {
      state.loading = false;
      $("reload").disabled = false;
      updateToolbar();
    }
  }
}

function hasRepoScope() {
  return !!(state.session && (state.session.scopes || []).includes(L.SCOPES.private));
}

async function noHostAccess() {
  if (L.isDotCom(state.host)) return false;
  try {
    return !(await chrome.permissions.contains({ origins: [`https://${state.host}/*`] }));
  } catch (_) {
    return false;
  }
}

// Shows a clear message for an API error.
async function showError(err) {
  const actions = $("errorActions");
  const reloadBtn = el("button", { type: "button", class: "primary", text: "Reload" });
  reloadBtn.addEventListener("click", () => load());
  const settings = el("button", { type: "button", text: "Open the settings" });
  settings.addEventListener("click", openSettings);
  const loginAgain = el("button", { type: "button", text: "Log in again" });
  loginAgain.addEventListener("click", openLogin);
  actions.replaceChildren(reloadBtn);

  const status = err && err.status;
  let text;
  if (err && err.ssoUrl) {
    text = `The organization ${state.owner} uses SAML single sign-on. Authorize your token for it, then reload.`;
    const a = el("a", { href: err.ssoUrl, target: "_blank", rel: "noopener", class: "button-link", text: "Authorize the token" });
    actions.prepend(a);
  } else if (err && err.rateLimited) {
    text = `You reached the GitHub API rate limit on ${state.host}. Wait some minutes, then reload.`;
  } else if (status === 401) {
    text = `${state.host} did not accept your token (HTTP 401). It may be expired or revoked. Log in again.`;
    actions.prepend(loginAgain);
  } else if (status === 404) {
    if (!hasRepoScope()) {
      text = `${repoFull()} was not found. If it is a private repository, the extension needs ` +
        `"Public and private repositories" access. Change the access for ${state.host} in the settings, then log in again.`;
      actions.append(settings);
    } else {
      text = `${repoFull()} was not found on ${state.host}, or your account cannot see it.`;
    }
  } else if (status === 403) {
    text = `${state.host} refused the request (HTTP 403): ${errText(err)}`;
  } else if (await noHostAccess()) {
    text = `The extension has no access to ${state.host}. Grant access in the settings, then reload.`;
    actions.append(settings);
  } else if (err instanceof TypeError || (err && err.status === 0 && err.code !== "bad_url")) {
    text = `Cannot connect to ${state.host}. Check your network, then reload.`;
  } else {
    text = status ? `${errText(err)} (HTTP ${status})` : errText(err);
  }
  $("errorText").textContent = text;
  state.report = null;
  show("errorView");
}

// ---- Render ----

function buildChips() {
  const box = $("chips");
  for (const [key, label] of CHIPS) {
    const btn = el("button", { type: "button", class: "chip", "data-status": key, "aria-pressed": "false" },
      el("span", { class: "chip-label", text: label }), " ", el("span", { class: "count", text: "0" }));
    btn.addEventListener("click", () => {
      state.filter.status = key;
      renderRows();
    });
    box.appendChild(btn);
  }
}

function renderReport() {
  const rep = state.report;
  const R = report();
  const fetched = rep.fetchedAt ? new Date(rep.fetchedAt) : null;
  const metaParts = [state.host, `default branch ${rep.defaultBranch || "unknown"}`, plural(rep.branches.length, "branch", "branches")];
  if (rep.private) metaParts.push("private");
  if (fetched && !isNaN(fetched)) metaParts.push(`read ${fetched.toLocaleString()}`);
  $("meta").textContent = metaParts.join(" · ");

  const warnings = Array.isArray(rep.warnings) ? rep.warnings : [];
  $("warnings").hidden = !warnings.length;
  $("warningList").replaceChildren(...warnings.map((w) => el("li", { text: w })));
  $("noPush").hidden = !!rep.canPush;

  // Chip counts use all rows. The counts do not change with search or creator.
  for (const btn of $("chips").children) {
    const n = R.filterRows(rep.branches, { status: btn.dataset.status, search: "", creator: "" }).length;
    btn.querySelector(".count").textContent = String(n);
  }

  // Creator list: people with the most branches first.
  const counts = new Map();
  for (const row of rep.branches) {
    const k = creatorKey(row);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const select = $("creator");
  const keep = state.filter.creator;
  const opts = [el("option", { value: "", text: "All" })];
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    opts.push(el("option", { value: k, text: `${k} (${n})` }));
  }
  select.replaceChildren(...opts);
  state.filter.creator = counts.has(keep) ? keep : "";
  select.value = state.filter.creator;

  renderRows();
}

const SORTERS = {
  name: (r) => r.name.toLowerCase(),
  date: (r) => Date.parse(r.lastCommit && r.lastCommit.date) || 0,
  committer: (r) => committerText(r).toLowerCase(),
  creator: (r) => creatorKey(r).toLowerCase(),
  pr: (r) => (r.pr ? r.pr.number : -1),
  ahead: (r) => (typeof r.aheadBy === "number" ? r.aheadBy : -1) * 1e6 + (typeof r.behindBy === "number" ? r.behindBy : 0),
  age: (r) => (typeof r.ageDays === "number" ? r.ageDays : -1)
};

function sortRows(rows) {
  const get = SORTERS[state.sort.key] || SORTERS.date;
  const dir = state.sort.dir === "asc" ? 1 : -1;
  return rows.map((r) => [get(r), r]).sort((a, b) => {
    const x = a[0], y = b[0];
    const c = typeof x === "string" ? x.localeCompare(y, undefined, { numeric: true }) : x - y;
    return c * dir || a[1].name.localeCompare(b[1].name);
  }).map((p) => p[1]);
}

function renderRows() {
  const rep = state.report;
  if (!rep) return;
  const rows = sortRows(report().filterRows(rep.branches, state.filter));
  state.visible = rows;

  for (const btn of $("chips").children) {
    btn.setAttribute("aria-pressed", String(btn.dataset.status === state.filter.status));
  }
  for (const th of document.querySelectorAll("th[data-sort]")) {
    const on = th.dataset.sort === state.sort.key;
    th.setAttribute("aria-sort", on ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none");
  }

  const body = $("rows");
  body.replaceChildren(...rows.map(renderRow));
  $("emptyMsg").hidden = rows.length > 0;
  updateToolbar();
}

function badge(text, cls, title) {
  return el("span", { class: `badge ${cls || ""}`.trim(), text, title });
}

function renderRow(row) {
  const tr = el("tr", { "data-name": row.name });
  const selectable = canSelect(row);

  // Checkbox.
  const box = el("input", { type: "checkbox", checked: state.selected.has(row.name), disabled: !selectable });
  const reason = selectable ? null : REASONS[row.deletable && row.deletable.reason] || "You cannot delete this branch.";
  box.setAttribute("aria-label", selectable ? `Select ${row.name}` : `${row.name}: ${reason}`);
  if (reason) box.title = reason;
  box.addEventListener("change", () => {
    if (box.checked) state.selected.add(row.name);
    else state.selected.delete(row.name);
    tr.classList.toggle("selected", box.checked);
    updateToolbar();
  });
  tr.classList.toggle("selected", box.checked);
  tr.appendChild(el("td", { class: "c-check", title: reason }, box));

  // Branch.
  const name = el("td", { class: "c-name" },
    el("a", { href: branchUrl(row.name), target: "_blank", rel: "noopener", class: "branch", text: row.name }));
  if (row.isDefault) name.append(" ", badge("default", "b-default"));
  if (row.protected) name.append(" ", badge("protected", "b-protected", "Protected branch"));
  tr.appendChild(name);

  // Last commit.
  const date = row.lastCommit && row.lastCommit.date;
  tr.appendChild(el("td", { class: "c-date nowrap" },
    date ? el("time", { datetime: date, title: exactTime(date), text: relTime(date) }) : el("span", { class: "muted", text: "unknown" })));

  // Last committer.
  const c = row.lastCommit || {};
  const who = committerText(row);
  const whoTitle = [c.authorName, c.authorEmail ? `<${c.authorEmail}>` : ""].filter(Boolean).join(" ");
  tr.appendChild(el("td", { class: "c-person" }, who ? el("span", { title: whoTitle || null, text: who }) : el("span", { class: "muted", text: "unknown" })));

  // Probable creator.
  const pc = row.probableCreator || { source: "none" };
  const creator = creatorKey(row);
  const ctd = el("td", { class: "c-person" });
  const srcText = CREATOR_SOURCES[pc.source] || CREATOR_SOURCES.none;
  if (creator && pc.source !== "none") {
    ctd.append(el("span", { title: pc.name && pc.name !== creator ? pc.name : null, text: creator }), " ",
      el("abbr", { class: "est", title: srcText, text: "est." }));
  } else {
    ctd.append(el("span", { class: "muted", title: srcText, text: "unknown" }));
  }
  tr.appendChild(ctd);

  // PR.
  const prTd = el("td", { class: "c-pr nowrap" });
  if (row.pr) {
    const st = String(row.pr.state || "").toUpperCase();
    const prLabel = { OPEN: "open", MERGED: "merged", CLOSED: "closed" }[st] || st.toLowerCase();
    const link = /^https:\/\//.test(String(row.pr.url || "")) ? row.pr.url : `${webRepo()}/pull/${Number(row.pr.number)}`;
    prTd.append(el("a", { href: link, target: "_blank", rel: "noopener", title: row.pr.title || null, text: `#${row.pr.number}` }),
      " ", badge(prLabel, `b-${prLabel}`));
    const others = openPrList(row).filter((num) => num !== row.pr.number);
    if (others.length) {
      prTd.append(" ", badge(`+${others.length} open`, "b-open",
        `Open pull request ${others.map((num) => `#${num}`).join(", ")}. Deleting the branch closes it.`));
    }
  } else if (row.mergedIntoDefault === true && !row.isDefault) {
    prTd.append(badge("merged, no PR", "b-merged-nopr", "All commits are on the default branch. No pull request."));
  } else {
    prTd.append(el("span", { class: "muted", text: "none" }));
  }
  tr.appendChild(prTd);

  // Ahead / behind.
  const ab = el("td", { class: "c-ab num nowrap" });
  if (row.isDefault) {
    ab.append(el("span", { class: "muted", text: "–" }));
  } else if (typeof row.aheadBy === "number" || typeof row.behindBy === "number") {
    const a = typeof row.aheadBy === "number" ? row.aheadBy : "?";
    const b = typeof row.behindBy === "number" ? row.behindBy : "?";
    ab.title = `${a} commits ahead of ${state.report.defaultBranch}, ${b} commits behind`;
    ab.append(el("span", { class: a === 0 ? "muted" : "", text: `${a} ahead` }), el("span", { class: "sep", text: " / " }),
      el("span", { class: b === 0 ? "muted" : "", text: `${b} behind` }));
  } else {
    ab.append(el("span", { class: "muted", text: "unknown" }));
  }
  tr.appendChild(ab);

  // Stale.
  const stale = el("td", { class: "c-stale nowrap" });
  if (row.stale) stale.append(badge("stale", "b-stale", `No new commit for ${row.ageDays} days`));
  tr.appendChild(stale);
  return tr;
}

function updateToolbar() {
  const rep = state.report;
  const canPush = !!(rep && rep.canPush);
  const n = state.selected.size;
  const visibleNames = new Set(state.visible.map((r) => r.name));
  const hidden = [...state.selected].filter((name) => !visibleNames.has(name)).length;

  const del = $("deleteBtn");
  del.textContent = `Delete selected (${n})`;
  del.disabled = !canPush || n === 0 || state.loading;
  del.title = !canPush ? "You do not have write access to this repository." : n === 0 ? "Select branches first." : "";
  $("restoreBtn").disabled = !canPush || state.loading;
  $("restoreBtn").title = canPush ? "" : "You do not have write access to this repository.";
  $("exportCsv").disabled = !rep;
  $("exportJson").disabled = !rep;
  $("selInfo").textContent = hidden ? `${hidden} selected ${hidden === 1 ? "branch is" : "branches are"} hidden by the filters.` : "";
  $("exportVisible").nextSibling.textContent = ` Visible rows only (${state.visible.length})`;

  // Header checkbox shows the state of the rows that "select all" can select.
  const eligible = state.visible.filter(autoSelectable);
  const on = eligible.filter((r) => state.selected.has(r.name)).length;
  const all = $("selectAll");
  all.disabled = !eligible.length || !canPush;
  all.checked = eligible.length > 0 && on === eligible.length;
  all.indeterminate = on > 0 && on < eligible.length;
}

// ---- Events ----

function bindEvents() {
  $("reload").addEventListener("click", () => load());
  $("loginBtn").addEventListener("click", openLogin);
  $("loginSettings").addEventListener("click", openSettings);

  let timer = null;
  $("search").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filter.search = $("search").value.trim();
      renderRows();
    }, 150);
  });
  $("creator").addEventListener("change", () => {
    state.filter.creator = $("creator").value;
    renderRows();
  });

  for (const th of document.querySelectorAll("th[data-sort]")) {
    th.querySelector("button").addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else state.sort = { key, dir: key === "date" || key === "age" || key === "ahead" ? "desc" : "asc" };
      renderRows();
    });
  }

  $("selectAll").addEventListener("change", () => {
    const eligible = state.visible.filter(autoSelectable);
    const allOn = eligible.every((r) => state.selected.has(r.name));
    for (const r of eligible) {
      if (allOn) state.selected.delete(r.name);
      else state.selected.add(r.name);
    }
    renderRows();
  });

  $("exportCsv").addEventListener("click", () => exportAs("csv"));
  $("exportJson").addEventListener("click", () => exportAs("json"));
  $("deleteBtn").addEventListener("click", () => startDelete());
  $("restoreBtn").addEventListener("click", () => {
    $("restoreFile").value = "";
    $("restoreFile").click();
  });
  $("restoreFile").addEventListener("change", () => {
    const file = $("restoreFile").files && $("restoreFile").files[0];
    if (file) startRestore(file);
  });

  bindDeleteDialog();
  bindRestoreDialog();

  // The user can log in in another tab. Check again when this tab is active.
  const recheck = () => {
    if (document.visibilityState === "visible" && (state.view === "loginView" || !state.session)) {
      checkSession().catch((err) => console.error(err));
    }
  };
  window.addEventListener("focus", recheck);
  document.addEventListener("visibilitychange", recheck);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.hosts) checkSessionChange().catch((err) => console.error(err));
  });
}

// A logout in another tab must stop the page from using the old token.
async function checkSessionChange() {
  const session = await A.getSession(state.host);
  if (!session) {
    if (state.session) {
      state.session = null;
      state.client = null;
      state.report = null;
      showLogin(`You are logged out of ${state.host}. Log in again to see the report.`);
    }
    return;
  }
  if (!state.session || session.token !== state.session.token) await checkSession();
}

// ---- Export ----

function exportRows() {
  const rep = state.report;
  const visibleOnly = $("exportVisible").checked;
  return visibleOnly ? Object.assign({}, rep, { branches: state.visible.slice() }) : rep;
}

function exportAs(kind) {
  const R = report();
  const rep = exportRows();
  if (!rep) return;
  const suffix = $("exportVisible").checked ? "-visible" : "";
  const name = `branches-${state.owner}-${state.repo}-${dateStamp(new Date())}${suffix}.${kind}`;
  try {
    if (kind === "csv") download(name, R.toCsv(rep), "text/csv;charset=utf-8");
    else download(name, R.toJson(rep, state.host), "application/json");
    setStatus($("toolStatus"), `Downloaded ${name} (${plural(rep.branches.length, "branch", "branches")}).`, "ok");
  } catch (err) {
    setStatus($("toolStatus"), `Export failed: ${errText(err)}`, "error");
  }
}

// ---- Delete ----

const del = { items: [], dry: null, running: false, done: false, backupName: "", trigger: null };

function bindDeleteDialog() {
  const dlg = $("delDialog");
  $("includeOpen").addEventListener("change", updateDeleteGate);
  $("confirmInput").addEventListener("input", updateDeleteGate);
  $("confirmInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("delGo").disabled) $("delGo").click();
  });
  $("delCancel").addEventListener("click", () => { if (!del.running) dlg.close(); });
  $("delGo").addEventListener("click", () => runDelete());
  // Esc must not close the dialog while branches are deleted.
  dlg.addEventListener("cancel", (e) => { if (del.running) e.preventDefault(); });
  dlg.addEventListener("close", () => {
    if (del.trigger && del.trigger.isConnected) del.trigger.focus();
  });
}

async function startDelete() {
  const R = report();
  const rep = state.report;
  if (!rep || !rep.canPush || !state.selected.size) return;
  const names = rep.branches.filter((r) => state.selected.has(r.name)).map((r) => r.name);
  setStatus($("toolStatus"), "Checking the selected branches…");
  $("deleteBtn").disabled = true;
  let dry;
  try {
    dry = await R.dryRun(state.client, rep, names);
  } catch (err) {
    setStatus($("toolStatus"), `The check failed: ${errText(err)}`, "error");
    updateToolbar();
    return;
  }
  setStatus($("toolStatus"), "");
  updateToolbar();

  Object.assign(del, { dry, running: false, done: false, trigger: $("deleteBtn"),
    backupName: `branches-backup-${state.owner}-${state.repo}-${timeStamp(new Date())}.json` });

  const groups = [
    ["delete", "Will delete", "These branches are deleted."],
    ["needs-confirm", "Needs confirmation", "These branches have an open pull request. Deleting the branch closes the pull request."],
    ["blocked", "Blocked", "These branches are not deleted."]
  ];
  const box = $("delGroups");
  box.replaceChildren();
  for (const [action, title, hint] of groups) {
    const items = dry.items.filter((i) => i.action === action);
    if (!items.length) continue;
    const list = el("ul", { class: "name-list" });
    for (const i of items) {
      const li = el("li", null, el("code", { text: i.name }));
      const row = rep.branches.find((r) => r.name === i.name);
      if (i.reason) li.append(" ", el("span", { class: "hint inline-hint", text: blockReason(i.reason) }));
      else if (action === "needs-confirm" && row && row.pr) li.append(" ", el("span", { class: "hint inline-hint", text: `PR #${row.pr.number}` }));
      list.appendChild(li);
    }
    box.appendChild(el("section", { class: `group g-${action}` },
      el("h3", { text: `${title} (${items.length})` }), el("p", { class: "hint", text: hint }), list));
  }

  const open = dry.items.filter((i) => i.action === "needs-confirm").length;
  $("openWrap").hidden = !open;
  $("includeOpen").checked = false;
  $("openLabel").textContent = `Also delete ${plural(open, "branch", "branches")} with open PRs (this closes the PRs)`;
  $("backupName").textContent = del.backupName;
  $("confirmTarget").textContent = repoFull();
  $("confirmInput").value = "";
  $("delReview").hidden = false;
  $("delRun").hidden = true;
  $("delCancel").textContent = "Cancel";
  $("delGo").hidden = false;
  updateDeleteGate();
  $("delDialog").showModal();
  $("confirmInput").focus();
}

function blockReason(reason) {
  return REASONS[reason] || String(reason);
}

// Items that the delete will use with the current choices.
function deleteItems() {
  if (!del.dry) return [];
  const withOpen = $("includeOpen").checked;
  return del.dry.items.filter((i) => i.action === "delete" || (withOpen && i.action === "needs-confirm"));
}

function updateDeleteGate() {
  const n = deleteItems().length;
  const typed = $("confirmInput").value === repoFull();
  const btn = $("delGo");
  btn.textContent = `Delete ${plural(n, "branch", "branches")}`;
  btn.disabled = !typed || n === 0 || del.running;
  $("confirmInput").setAttribute("aria-invalid", String($("confirmInput").value !== "" && !typed));
}

async function runDelete() {
  const R = report();
  const items = deleteItems().map((i) => ({ name: i.name, sha: i.sha }));
  if (!items.length || $("confirmInput").value !== repoFull() || del.running) return;
  del.running = true;
  $("delGo").disabled = true;
  $("delCancel").disabled = true;

  // Backup first. The delete does not start when the backup fails.
  const shaByName = new Map(items.map((i) => [i.name, i.sha]));
  const backupRows = state.report.branches.filter((r) => shaByName.has(r.name))
    .map((r) => Object.assign({}, r, { sha: shaByName.get(r.name) }));
  try {
    const text = R.toJson(Object.assign({}, state.report, { branches: backupRows }), state.host);
    download(del.backupName, text, "application/json");
  } catch (err) {
    del.running = false;
    $("delCancel").disabled = false;
    updateDeleteGate();
    $("delProgress").textContent = "";
    $("delReview").hidden = false;
    alertInDialog(`The backup failed, so nothing was deleted: ${errText(err)}`);
    return;
  }
  // Give the browser time to start the download.
  await new Promise((r) => setTimeout(r, 400));

  $("delReview").hidden = true;
  $("delRun").hidden = false;
  $("delBackupDone").textContent = `Backup downloaded: ${del.backupName}`;
  $("delSummary").textContent = "";
  const bar = $("delBar");
  bar.max = items.length;
  bar.value = 0;
  const lis = new Map();
  $("delList").replaceChildren(...items.map((i) => {
    const st = el("span", { class: "st muted", text: "Waiting" });
    const li = el("li", null, el("code", { text: i.name }), st);
    lis.set(i.name, st);
    return li;
  }));
  let done = 0;
  const progress = () => { $("delProgress").textContent = `Deleting ${done}/${items.length}…`; };
  progress();

  let results = [];
  try {
    results = await R.deleteBranches(state.client, { owner: state.owner, repo: state.repo }, items, (res) => {
      done++;
      bar.value = done;
      progress();
      setResult(lis.get(res.name), DELETE_STATUS, res);
    });
  } catch (err) {
    $("delSummary").textContent = `The delete stopped: ${errText(err)}`;
    $("delSummary").className = "summary error";
  }
  for (const res of results || []) setResult(lis.get(res.name), DELETE_STATUS, res);

  const count = (s) => (results || []).filter((r) => r.status === s).length;
  if (results && results.length) {
    $("delProgress").textContent = `Done. ${count("deleted")} of ${items.length} deleted.`;
    $("delSummary").className = "summary";
    $("delSummary").textContent = `Deleted: ${count("deleted")}. Changed since the report (not deleted): ${count("changed")}. ` +
      `Already gone: ${count("gone")}. Failed: ${count("failed")}.`;
  }
  del.running = false;
  del.done = true;
  $("delCancel").disabled = false;
  $("delCancel").textContent = "Close";
  $("delGo").hidden = true;
  $("delCancel").focus();
  state.selected.clear();
  renderRows();
  load();
}

function alertInDialog(text) {
  $("delProgress").textContent = text;
  $("delRun").hidden = false;
  $("delList").replaceChildren();
}

// Writes a status label into a list row.
function setResult(node, table, res) {
  if (!node) return;
  const [label, cls] = table[res.status] || [String(res.status), "muted"];
  // Show the error text only for failures. The other labels explain the result.
  node.textContent = res.error && (res.status === "failed" || res.status === "invalid") ? `${label}: ${errText(res.error)}` : label;
  if (res.error) node.title = errText(res.error);
  node.className = `st ${cls}`;
}

// ---- Restore ----

const res = { parsed: null, fileName: "", running: false, mismatch: false, boxes: [], trigger: null };

function bindRestoreDialog() {
  const dlg = $("resDialog");
  $("resCancel").addEventListener("click", () => { if (!res.running) dlg.close(); });
  $("resGo").addEventListener("click", () => runRestore());
  $("resMismatchOk").addEventListener("change", updateRestoreGate);
  $("resAll").addEventListener("change", () => {
    for (const b of res.boxes) if (!b.disabled) b.checked = $("resAll").checked;
    updateRestoreGate();
  });
  dlg.addEventListener("cancel", (e) => { if (res.running) e.preventDefault(); });
  dlg.addEventListener("close", () => {
    if (res.trigger && res.trigger.isConnected) res.trigger.focus();
  });
}

async function startRestore(file) {
  const R = report();
  let text;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("The file is too large.");
    text = await file.text();
  } catch (err) {
    setStatus($("toolStatus"), `Cannot read ${file.name}: ${errText(err)}`, "error");
    return;
  }
  let parsed;
  try {
    parsed = R.parseExport(text);
  } catch (err) {
    setStatus($("toolStatus"), `${file.name} is not a branch export: ${errText(err)}`, "error");
    return;
  }
  Object.assign(res, { parsed, fileName: file.name, running: false, trigger: $("restoreBtn") });

  const from = [parsed.host, parsed.owner && parsed.repo ? `${parsed.owner}/${parsed.repo}` : null].filter(Boolean).join("/");
  $("resSource").textContent = `File: ${file.name}` + (from ? ` · from ${from}` : "") +
    ` · ${plural(parsed.branches.length, "branch", "branches")}`;

  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  $("resErrors").hidden = !errors.length;
  $("resErrorList").replaceChildren(...errors.slice(0, 20).map((e) => el("li", { text: errText(e) })),
    ...(errors.length > 20 ? [el("li", { text: `…and ${errors.length - 20} more.` })] : []));

  // Compare the file with this page. Owner and repo names are not case sensitive on GitHub.
  const diff = [];
  const lc = (s) => String(s || "").toLowerCase();
  if (parsed.host && lc(parsed.host) !== state.host) diff.push(`host ${parsed.host}`);
  if (parsed.owner && lc(parsed.owner) !== lc(state.owner)) diff.push(`owner ${parsed.owner}`);
  if (parsed.repo && lc(parsed.repo) !== lc(state.repo)) diff.push(`repository ${parsed.repo}`);
  res.mismatch = diff.length > 0;
  $("resMismatch").hidden = !res.mismatch;
  $("resMismatchText").textContent = res.mismatch
    ? `This file is from a different place (${diff.join(", ")}). This page is ${state.host}/${repoFull()}.`
    : "";
  $("resMismatchLabel").textContent = `Restore to ${state.host}/${repoFull()} anyway`;
  $("resMismatchOk").checked = false;

  // Branches that exist now are not selected.
  const existing = new Set((state.report ? state.report.branches : []).map((r) => r.name));
  res.boxes = [];
  res.status = new Map();
  $("resList").replaceChildren(...parsed.branches.map((b, idx) => {
    const exists = existing.has(b.name);
    const box = el("input", { type: "checkbox", checked: !exists, id: `res-${idx}` });
    box.dataset.idx = String(idx);
    box.addEventListener("change", updateRestoreGate);
    res.boxes.push(box);
    const st = el("span", { class: "st muted", text: exists ? "Exists now" : "" });
    res.status.set(b.name, st);
    return el("li", null, box, el("label", { htmlFor: `res-${idx}`, class: "inline" },
      el("code", { text: b.name }), " ", el("span", { class: "hint inline-hint", text: shortSha(b.sha) })), st);
  }));
  $("resList").hidden = !parsed.branches.length;
  $("resAll").parentElement.hidden = !parsed.branches.length;
  $("resProgress").textContent = parsed.branches.length ? "" : "The file has no branches to restore.";
  $("resSummary").textContent = "";
  $("resCancel").textContent = "Cancel";
  $("resGo").hidden = false;
  updateRestoreGate();
  $("resDialog").showModal();
  (res.boxes[0] || $("resCancel")).focus();
}

function restoreItems() {
  return res.boxes.filter((b) => b.checked && !b.disabled).map((b) => res.parsed.branches[Number(b.dataset.idx)]);
}

function updateRestoreGate() {
  const n = restoreItems().length;
  const btn = $("resGo");
  btn.textContent = `Restore ${plural(n, "branch", "branches")}`;
  btn.disabled = res.running || n === 0 || (res.mismatch && !$("resMismatchOk").checked) ||
    !(state.report && state.report.canPush);
  const selectable = res.boxes.filter((b) => !b.disabled);
  const on = selectable.filter((b) => b.checked).length;
  $("resAll").checked = selectable.length > 0 && on === selectable.length;
  $("resAll").indeterminate = on > 0 && on < selectable.length;
}

async function runRestore() {
  const R = report();
  const entries = restoreItems().map((b) => ({ name: b.name, sha: b.sha }));
  if (!entries.length || res.running) return;
  res.running = true;
  updateRestoreGate();
  $("resCancel").disabled = true;
  for (const b of res.boxes) b.disabled = true;
  $("resAll").disabled = true;
  $("resMismatchOk").disabled = true;
  for (const e of entries) {
    const st = res.status.get(e.name);
    if (st) { st.textContent = "Waiting"; st.className = "st muted"; }
  }
  let done = 0;
  const progress = () => { $("resProgress").textContent = `Restoring ${done}/${entries.length}…`; };
  progress();
  let results = [];
  try {
    results = await R.restoreBranches(state.client, { owner: state.owner, repo: state.repo }, entries, (r) => {
      done++;
      progress();
      setResult(res.status.get(r.name), RESTORE_STATUS, r);
    });
  } catch (err) {
    $("resSummary").textContent = `The restore stopped: ${errText(err)}`;
    $("resSummary").className = "summary error";
  }
  for (const r of results || []) setResult(res.status.get(r.name), RESTORE_STATUS, r);
  const count = (s) => (results || []).filter((r) => r.status === s).length;
  if (results && results.length) {
    $("resProgress").textContent = `Done. ${count("restored")} of ${entries.length} restored.`;
    $("resSummary").className = "summary";
    $("resSummary").textContent = `Restored: ${count("restored")}. Already exists: ${count("exists")}. ` +
      `Not valid: ${count("invalid")}. Failed: ${count("failed")}.`;
  }
  res.running = false;
  $("resCancel").disabled = false;
  $("resCancel").textContent = "Close";
  $("resGo").hidden = true;
  $("resAll").disabled = false;
  $("resMismatchOk").disabled = false;
  $("resCancel").focus();
  load();
}

start().catch((err) => {
  console.error(err);
  showError(err);
});
