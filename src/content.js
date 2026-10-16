// Adds a "Branch report" button on a repository's Branches page.
"use strict";

(function () {
  const L = globalThis.CpLib;
  const ID = "br-button";
  const HOST = location.hostname;
  // All selectors in one place. GitHub changes its page structure often.
  const SELECTORS = {
    heading: "main h1, main h2, [data-testid='branches-page'] h1, #repo-content-turbo-frame h1"
  };

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; ensureButton(); }, 150);
  }

  function ensureButton() {
    const ctx = L.parseBranchesPage(location.pathname);
    const existing = document.getElementById(ID);
    if (!ctx) {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.isConnected && existing.dataset.repo === `${ctx.owner}/${ctx.repo}`) return;
    if (existing) existing.remove();
    const btn = document.createElement("button");
    btn.id = ID;
    btn.type = "button";
    btn.dataset.repo = `${ctx.owner}/${ctx.repo}`;
    btn.textContent = "Branch report";
    btn.title = "List branches with authors and pull request status. Export or delete them.";
    btn.addEventListener("click", () => openReport(ctx));
    const heading = Array.from(document.querySelectorAll(SELECTORS.heading))
      .find((h) => /^\s*Branches\s*$/i.test(h.textContent || ""));
    if (heading) {
      btn.className = "br-btn br-inline";
      heading.insertAdjacentElement("afterend", btn);
    } else {
      // No anchor: a floating button, so the feature does not disappear.
      btn.className = "br-btn br-floating";
      document.body.appendChild(btn);
    }
  }

  async function openReport(ctx) {
    try {
      await chrome.runtime.sendMessage({ type: "openReport", host: HOST, owner: ctx.owner, repo: ctx.repo });
    } catch (err) {
      // The extension was reloaded. The old content script cannot talk to it.
      alert("Branch Report was updated. Reload this page, then try again.");
    }
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  for (const ev of ["turbo:load", "turbo:render", "popstate", "pjax:end"]) window.addEventListener(ev, schedule);
  document.addEventListener("turbo:load", schedule);
  schedule();
})();
