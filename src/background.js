// Background: opens extension pages and keeps GHES content scripts registered.
// The report page calls the GitHub API itself (it is an extension page with host access).
//
// Messages (chrome.runtime.sendMessage), reply { ok: true } or { ok: false, error }:
//   { type: "openReport", host, owner, repo } → opens src/report.html for that repo
//   { type: "openOptions" }                   → opens the settings page
"use strict";

if (typeof importScripts === "function") {
  // Chrome service worker. Firefox loads these from manifest background.scripts.
  importScripts("lib.js", "auth.js", "hosts.js");
}

const L = globalThis.CpLib;
const sync = () => { CpHosts.syncContentScripts().catch((err) => console.error(err)); };

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
// The user can grant or remove host access in the browser settings too.
chrome.permissions.onAdded.addListener(sync);
chrome.permissions.onRemoved.addListener(sync);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.hosts) sync();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

const NAME_RE = /^[A-Za-z0-9._-]+$/;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === "openReport") {
      const host = L.normalizeHost(msg.host);
      if (!host || !NAME_RE.test(String(msg.owner)) || !NAME_RE.test(String(msg.repo))) {
        throw new Error("Not a valid repository.");
      }
      const q = new URLSearchParams({ host, owner: msg.owner, repo: msg.repo });
      await chrome.tabs.create({ url: chrome.runtime.getURL(`src/report.html?${q}`) });
      return {};
    }
    if (msg && msg.type === "openOptions") {
      await chrome.runtime.openOptionsPage();
      return {};
    }
    return null;
  })().then(
    (out) => sendResponse(out ? Object.assign({ ok: true }, out) : { ok: false, error: { code: "unknown_message" } }),
    (err) => sendResponse({ ok: false, error: { code: "error", message: String(err.message || err) } })
  );
  return true;
});
