// Branch report data: load, dry run, delete, restore, export, import, filter.
// No DOM. The report page and the Node tests use it.
(function (root) {
  "use strict";

  const L = typeof module === "object" && module.exports ? require("./lib.js") : root.CpLib;

  // Above this number of branches, compare calls run only when the caller asks for them.
  const DETAILS_CAP = 1000;
  // Safety stop for the branch list: 500 pages of 100 refs.
  const MAX_REF_PAGES = 500;
  // Show this many compare errors one by one. Then show one summary line.
  const MAX_COMPARE_WARNINGS = 20;
  const DAY_MS = 86400000;
  const SHA_RE = /^[0-9a-f]{40}$/;
  const PUSH_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

  // refUpdateRule is the protection rule that users without admin access can see.
  // branchProtectionRule can be null for these users.
  const REPORT_QUERY = `query BranchReport($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    isPrivate
    viewerPermission
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: 100, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        branchProtectionRule { pattern }
        refUpdateRule { pattern }
        target {
          oid
          ... on Commit {
            oid
            committedDate
            author { name email user { login } }
          }
        }
        associatedPullRequests(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { number state url title mergedAt author { login } }
        }
      }
    }
  }
}`;

  // ---------- helpers ----------

  // Encode each path segment. Keep "/" between segments.
  function encodePath(name) {
    return String(name).split("/").map(encodeURIComponent).join("/");
  }

  function repoPath(owner, repo) {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  function errorText(err) {
    if (!err) return "Unknown error.";
    return String(err.apiMessage || err.message || err);
  }

  function report(fn, value) {
    if (typeof fn !== "function") return;
    try { fn(value); } catch (_) { /* A UI callback error must not stop the work. */ }
  }

  // Runs worker(item, index) for all items with at most `limit` running at the same time.
  async function pool(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    const n = Math.max(1, Math.min(limit || 1, items.length));
    async function lane() {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: n }, lane));
    return out;
  }

  // GET a branch ref. Returns the head sha, or null when the branch does not exist.
  async function getRefSha(client, base, name) {
    try {
      const data = await client.get(`${base}/git/ref/heads/${encodePath(name)}`);
      // The singular endpoint matches exactly. Check anyway: never act on a different ref.
      if (!data || Array.isArray(data) || data.ref !== `refs/heads/${name}` || !data.object) return null;
      return data.object.sha;
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  }

  // ---------- loadReport ----------

  function toRow(node, ctx) {
    const t = node.target || {};
    const author = t.author || {};
    const prs = (node.associatedPullRequests && node.associatedPullRequests.nodes || []).filter(Boolean);
    const newest = prs[0] || null;
    const oldest = prs[prs.length - 1] || null;
    const isDefault = node.name === ctx.defaultBranch;
    const isProtected = !!(node.branchProtectionRule || node.refUpdateRule);
    const date = t.committedDate || null;
    const time = date ? Date.parse(date) : NaN;
    const ageDays = Number.isFinite(time) ? Math.max(0, Math.floor((ctx.now - time) / DAY_MS)) : null;

    let reason = null;
    if (isDefault) reason = "default";
    else if (isProtected) reason = "protected";
    else if (!ctx.canPush) reason = "no-permission";

    const row = {
      name: node.name,
      sha: t.oid || null,
      isDefault,
      protected: isProtected,
      lastCommit: {
        date,
        authorName: author.name || null,
        authorEmail: author.email || null,
        login: author.user && author.user.login || null
      },
      pr: newest ? {
        number: newest.number,
        state: newest.state,
        url: newest.url,
        title: newest.title,
        author: newest.author && newest.author.login || null,
        mergedAt: newest.mergedAt || null
      } : null,
      // Numbers of all open pull requests found for this head branch.
      openPrs: prs.filter((p) => p.state === "OPEN").map((p) => p.number),
      aheadBy: isDefault ? 0 : null,
      behindBy: isDefault ? 0 : null,
      mergedIntoDefault: isDefault ? false : null,
      probableCreator: { login: null, name: null, source: "none" },
      ageDays,
      stale: ageDays !== null && ageDays >= ctx.staleDays,
      deletable: { ok: reason === null, reason }
    };
    if (oldest && oldest.author && oldest.author.login) {
      row.probableCreator = { login: oldest.author.login, name: null, source: "pr" };
    }
    return row;
  }

  // Sets ahead/behind and maybe the probable creator from a compare response.
  function applyCompare(row, data) {
    row.aheadBy = typeof data.ahead_by === "number" ? data.ahead_by : null;
    row.behindBy = typeof data.behind_by === "number" ? data.behind_by : null;
    row.mergedIntoDefault = row.aheadBy === null ? null : row.aheadBy === 0;
    // The compare list is in chronological order. With per_page=1, page 1 holds the oldest commit.
    const first = Array.isArray(data.commits) ? data.commits[0] : null;
    if (row.probableCreator.source === "none" && row.aheadBy > 0 && first) {
      const login = first.author && first.author.login || null;
      const name = first.commit && first.commit.author && first.commit.author.name || null;
      if (login || name) row.probableCreator = { login, name, source: "first-commit" };
    }
  }

  // Older GitHub Enterprise Server versions do not know refUpdateRule.
  // Then the query fails as a whole, so retry once without that field.
  const LEGACY_QUERY = REPORT_QUERY.replace(/\n\s*refUpdateRule \{ pattern \}/, "");
  const legacyClients = new WeakSet();
  async function queryPage(client, vars, warnings) {
    if (!legacyClients.has(client)) {
      try {
        return await client.graphql(REPORT_QUERY, vars);
      } catch (err) {
        if (!/refUpdateRule/.test(String(err && err.message))) throw err;
        legacyClients.add(client);
        warnings.push("This GitHub version cannot show protection rules to non-admins. Protected branches may show as not protected.");
      }
    }
    return client.graphql(LEGACY_QUERY, vars);
  }

  async function loadReport(client, opts, onProgress) {
    opts = opts || {};
    const { owner, repo } = opts;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const staleDays = Number.isFinite(opts.staleDays) && opts.staleDays > 0 ? opts.staleDays : L.DEFAULT_STALE_DAYS;
    const concurrency = Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 4;
    const warnings = [];

    // 1. Branch list (GraphQL, 100 per page).
    const nodes = [];
    let meta = null;
    let after = null;
    let total = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_REF_PAGES) {
        warnings.push(`Stopped after ${nodes.length} branches. The list is not complete.`);
        break;
      }
      const data = await queryPage(client, { owner, name: repo, after }, warnings);
      const r = data && data.repository;
      if (!r) {
        const err = new Error(`Repository ${owner}/${repo} not found.`);
        err.status = 404;
        err.code = "not_found";
        throw err;
      }
      if (!meta) meta = r;
      const refs = r.refs || { nodes: [], pageInfo: {} };
      if (typeof refs.totalCount === "number") total = refs.totalCount;
      nodes.push(...(refs.nodes || []).filter(Boolean));
      report(onProgress, { phase: "branches", done: nodes.length, total: total === null ? nodes.length : total });
      const info = refs.pageInfo || {};
      if (!info.hasNextPage || !info.endCursor) break;
      after = info.endCursor;
    }

    const defaultBranch = meta.defaultBranchRef && meta.defaultBranchRef.name || null;
    const canPush = PUSH_PERMISSIONS.has(meta.viewerPermission);
    const ctx = { defaultBranch, canPush, now, staleDays };
    const branches = nodes.map((n) => toRow(n, ctx));
    if (!defaultBranch) warnings.push("The repository has no default branch. Ahead/behind counts are not available.");

    // 2. Details (REST compare against the default branch).
    const details = typeof opts.details === "boolean" ? opts.details : branches.length <= DETAILS_CAP;
    const targets = defaultBranch ? branches.filter((b) => !b.isDefault) : [];
    if (!details && targets.length) {
      warnings.push(branches.length > DETAILS_CAP
        ? `This repository has ${branches.length} branches (more than ${DETAILS_CAP}). Ahead/behind counts were not loaded.`
        : "Ahead/behind counts were not loaded.");
    } else if (targets.length) {
      const base = repoPath(owner, repo);
      const head = encodePath(defaultBranch);
      let done = 0;
      let failed = 0;
      report(onProgress, { phase: "details", done, total: targets.length });
      await pool(targets, concurrency, async (row) => {
        try {
          const data = await client.get(`${base}/compare/${head}...${encodePath(row.name)}?per_page=1`);
          applyCompare(row, data || {});
        } catch (err) {
          failed++;
          if (failed <= MAX_COMPARE_WARNINGS) warnings.push(`Could not compare "${row.name}" with "${defaultBranch}": ${errorText(err)}`);
        }
        done++;
        report(onProgress, { phase: "details", done, total: targets.length });
      });
      if (failed > MAX_COMPARE_WARNINGS) warnings.push(`${failed - MAX_COMPARE_WARNINGS} more branches could not be compared.`);
    }

    return {
      owner,
      repo,
      defaultBranch,
      private: !!meta.isPrivate,
      canPush,
      fetchedAt: new Date(now).toISOString(),
      branches,
      warnings
    };
  }

  // ---------- dryRun ----------

  async function hasDeletionRule(client, base, name) {
    try {
      const rules = await client.paginate(`${base}/rules/branches/${encodePath(name)}?per_page=100`, { maxPages: 10 });
      return rules.some((r) => r && r.type === "deletion");
    } catch (err) {
      // Old GHES versions have no rulesets endpoint.
      if (err && err.status === 404) return false;
      throw err;
    }
  }

  async function checkOne(client, rep, base, rowsByName, name) {
    const row = rowsByName.get(name);
    const item = (action, reason) => ({ name, sha: row ? row.sha : null, action, reason });
    if (!row) return item("blocked", "The branch is not in this report.");
    if (row.isDefault) return item("blocked", "This is the default branch.");
    if (row.protected) return item("blocked", "The branch is protected.");
    if (!rep.canPush) return item("blocked", "You do not have push permission.");
    try {
      const sha = await getRefSha(client, base, name);
      if (sha === null) return item("blocked", "The branch no longer exists.");
      if (sha !== row.sha) return item("blocked", "The branch has new commits since the report. Reload the report.");
    } catch (err) {
      return item("blocked", `Could not check the branch: ${errorText(err)}`);
    }
    try {
      if (await hasDeletionRule(client, base, name)) return item("blocked", "A ruleset blocks deletion of this branch.");
    } catch (err) {
      return item("blocked", `Could not check rulesets: ${errorText(err)}`);
    }
    const open = Array.isArray(row.openPrs) ? row.openPrs : (row.pr && row.pr.state === "OPEN" ? [row.pr.number] : []);
    if (open.length) {
      const list = open.map((n) => `#${n}`).join(", ");
      return item("needs-confirm", `Open pull request ${list}. Deleting the branch closes it.`);
    }
    return item("delete", null);
  }

  async function dryRun(client, rep, names, opts) {
    const base = repoPath(rep.owner, rep.repo);
    const rowsByName = new Map((rep.branches || []).map((b) => [b.name, b]));
    const unique = [...new Set(names || [])];
    const concurrency = opts && opts.concurrency > 0 ? opts.concurrency : 4;
    const items = await pool(unique, concurrency, (name) => checkOne(client, rep, base, rowsByName, name));
    const counts = { delete: 0, blocked: 0, needsConfirm: 0 };
    for (const it of items) {
      if (it.action === "delete") counts.delete++;
      else if (it.action === "blocked") counts.blocked++;
      else counts.needsConfirm++;
    }
    return { items, counts };
  }

  // ---------- deleteBranches ----------

  async function deleteBranches(client, { owner, repo }, items, onEach) {
    const base = repoPath(owner, repo);
    const results = [];
    for (const it of items || []) {
      const name = it && it.name;
      const sha = it && it.sha;
      const result = { name, sha, status: "failed", error: null };
      try {
        if (!L.isValidBranchName(name)) throw new Error("The branch name is not valid.");
        if (!SHA_RE.test(String(sha))) throw new Error("The commit SHA is not valid.");
        const current = await getRefSha(client, base, name);
        if (current === null) result.status = "gone";
        else if (current !== sha) {
          result.status = "changed";
          result.error = "The branch has new commits. It was not deleted.";
        } else {
          try {
            await client.del(`${base}/git/refs/heads/${encodePath(name)}`);
            result.status = "deleted";
          } catch (err) {
            // Another client can delete the branch between the GET and the DELETE.
            if (err && err.status === 422 && /does not exist/i.test(errorText(err))) result.status = "gone";
            else throw err;
          }
        }
      } catch (err) {
        result.status = "failed";
        result.error = errorText(err);
      }
      results.push(result);
      report(onEach, result);
    }
    return results;
  }

  // ---------- restoreBranches ----------

  async function restoreBranches(client, { owner, repo }, entries, onEach) {
    const base = repoPath(owner, repo);
    const results = [];
    for (const e of entries || []) {
      const name = e && e.name;
      const sha = e && typeof e.sha === "string" ? e.sha.toLowerCase() : e && e.sha;
      const result = { name, sha, status: "failed", error: null };
      if (!L.isValidBranchName(name)) {
        result.status = "invalid";
        result.error = "The branch name is not valid.";
      } else if (!SHA_RE.test(String(sha))) {
        result.status = "invalid";
        result.error = "The commit SHA is not valid.";
      } else {
        try {
          if (await getRefSha(client, base, name) !== null) {
            result.status = "exists";
            result.error = "A branch with this name exists. It was not changed.";
          } else {
            await client.post(`${base}/git/refs`, { ref: `refs/heads/${name}`, sha });
            result.status = "restored";
          }
        } catch (err) {
          const msg = errorText(err);
          if (err && err.status === 422 && /already exists/i.test(msg)) {
            result.status = "exists";
            result.error = "A branch with this name exists. It was not changed.";
          } else if (err && err.status === 422) {
            result.status = "failed";
            result.error = `GitHub did not accept commit ${sha.slice(0, 7)}. The commit may no longer exist in this repository. (${msg})`;
          } else {
            result.status = "failed";
            result.error = msg;
          }
        }
      }
      results.push(result);
      report(onEach, result);
    }
    return results;
  }

  // ---------- CSV / JSON export ----------

  const CSV_COLUMNS = [
    "branch", "sha", "default", "protected", "last_commit_date", "last_committer_login", "last_committer_name",
    "probable_creator", "creator_source", "pr_number", "pr_state", "pr_url", "ahead", "behind",
    "merged_into_default", "stale", "age_days"
  ];

  // A spreadsheet runs a cell that starts with one of these as a formula.
  // We also escape a leading quote, so that parseExport can undo the escape without loss.
  const FORMULA_START = /^[=+\-@\t\r']/;

  function csvCell(value) {
    let s = value === null || value === undefined ? "" : String(value);
    if (FORMULA_START.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function csvValues(r) {
    const c = r.probableCreator || {};
    const pr = r.pr || null;
    const lc = r.lastCommit || {};
    return [
      r.name, r.sha, r.isDefault, r.protected, lc.date, lc.login, lc.authorName,
      c.login || c.name || "", c.source, pr && pr.number, pr && pr.state, pr && pr.url,
      r.aheadBy, r.behindBy, r.mergedIntoDefault, r.stale, r.ageDays
    ];
  }

  function toCsv(rep) {
    const lines = [CSV_COLUMNS.join(",")];
    for (const r of rep.branches || []) lines.push(csvValues(r).map(csvCell).join(","));
    return lines.join("\r\n") + "\r\n";
  }

  function toJson(rep, host) {
    return JSON.stringify({
      format: "branch-report",
      version: 1,
      host: host || null,
      owner: rep.owner,
      repo: rep.repo,
      defaultBranch: rep.defaultBranch,
      fetchedAt: rep.fetchedAt,
      branches: rep.branches || []
    }, null, 2);
  }

  // ---------- parseExport ----------

  // RFC 4180 parser. Accepts CRLF and LF. Returns an array of rows (arrays of strings).
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        cell += ch; i++; continue;
      }
      if (ch === '"' && cell === "") { quoted = true; i++; continue; }
      if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
      if (ch === "\r" || ch === "\n") {
        row.push(cell); rows.push(row); row = []; cell = "";
        i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      cell += ch; i++;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Undo the anti-formula quote from csvCell.
  function unescapeCell(s) {
    return /^'[=+\-@\t\r']/.test(s) ? s.slice(1) : s;
  }

  function checkEntry(name, sha, label, out, seen, errors) {
    const n = typeof name === "string" ? name : "";
    const s = typeof sha === "string" ? sha.trim().toLowerCase() : "";
    if (!L.isValidBranchName(n)) { errors.push(`${label}: the branch name is not valid.`); return; }
    if (!SHA_RE.test(s)) { errors.push(`${label}: the SHA for "${n}" is not valid.`); return; }
    if (seen.has(n)) { errors.push(`${label}: "${n}" is a duplicate.`); return; }
    seen.add(n);
    out.push({ name: n, sha: s });
  }

  function parseExport(text) {
    const result = { host: null, owner: null, repo: null, branches: [], errors: [] };
    const src = String(text || "").replace(/^﻿/, "");
    const seen = new Set();
    if (/^\s*$/.test(src)) {
      result.errors.push("The file is empty.");
      return result;
    }
    if (/^\s*[{[]/.test(src)) {
      let data;
      try { data = JSON.parse(src); } catch (_) {
        result.errors.push("The file is not valid JSON.");
        return result;
      }
      if (!data || typeof data !== "object" || Array.isArray(data) || data.format !== "branch-report") {
        result.errors.push("The JSON file is not a branch report export.");
        return result;
      }
      if (data.version !== 1) result.errors.push(`Unknown export version ${JSON.stringify(data.version)}. Trying anyway.`);
      for (const key of ["host", "owner", "repo"]) if (typeof data[key] === "string" && data[key]) result[key] = data[key];
      if (!Array.isArray(data.branches)) {
        result.errors.push("The JSON file has no branch list.");
        return result;
      }
      data.branches.forEach((b, i) => {
        if (!b || typeof b !== "object") { result.errors.push(`Branch ${i + 1}: not an object.`); return; }
        checkEntry(b.name, b.sha, `Branch ${i + 1}`, result.branches, seen, result.errors);
      });
      return result;
    }

    const rows = parseCsv(src);
    const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
    const iName = header.indexOf("branch");
    const iSha = header.indexOf("sha");
    if (iName < 0 || iSha < 0) {
      result.errors.push('The CSV file needs a header row with "branch" and "sha" columns.');
      return result;
    }
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (cells.every((c) => c === "")) continue;
      const name = cells[iName] === undefined ? "" : unescapeCell(cells[iName]);
      const sha = cells[iSha] === undefined ? "" : unescapeCell(cells[iSha]);
      checkEntry(name, sha, `Line ${r + 1}`, result.branches, seen, result.errors);
    }
    return result;
  }

  // ---------- filterRows ----------

  function lower(s) {
    return typeof s === "string" ? s.toLowerCase() : "";
  }

  // status filters other than "all" never return the default branch.
  function matchStatus(r, status) {
    if (!status || status === "all") return true;
    if (r.isDefault) return false;
    const state = r.pr && r.pr.state;
    switch (status) {
      case "no-pr": return !r.pr;
      case "open": return state === "OPEN";
      case "merged": return state === "MERGED";
      case "closed": return state === "CLOSED";
      case "merged-no-pr": return !r.pr && r.mergedIntoDefault === true;
      case "stale": return !!r.stale;
      default: return true;
    }
  }

  function filterRows(rows, f) {
    f = f || {};
    const q = lower(String(f.search || "").trim());
    const who = lower(String(f.creator || "").trim());
    return (rows || []).filter((r) => {
      if (!matchStatus(r, f.status)) return false;
      const c = r.probableCreator || {};
      if (who && lower(c.login) !== who && lower(c.name) !== who) return false;
      if (!q) return true;
      const lc = r.lastCommit || {};
      const fields = [r.name, lc.login, lc.authorName, c.login, c.name, r.pr && r.pr.author];
      return fields.some((v) => lower(v).includes(q));
    });
  }

  const api = {
    DETAILS_CAP, CSV_COLUMNS, REPORT_QUERY,
    loadReport, dryRun, deleteBranches, restoreBranches,
    toCsv, toJson, parseExport, filterRows, encodePath, parseCsv
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CpReport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
