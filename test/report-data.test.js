"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("../src/api.js");
const R = require("../src/report-data.js");
const { createFakeGitHub, sha, API, GRAPHQL } = require("./fake-github.js");

const NOW = Date.parse("2025-06-01T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

function setup(config) {
  const gh = createFakeGitHub(Object.assign({ owner: "o", repo: "r" }, config));
  const client = createClient({ apiBase: API, graphqlUrl: GRAPHQL, token: "t", fetchImpl: gh.fetch, sleep: async () => {} });
  return { gh, client };
}

function load(client, extra, onProgress) {
  return R.loadReport(client, Object.assign({ owner: "o", repo: "r", now: NOW, staleDays: 90 }, extra), onProgress);
}

const byName = (rep, name) => rep.branches.find((b) => b.name === name);

function sample() {
  return {
    branches: [
      { name: "main", sha: sha(1), date: daysAgo(1), login: "lead", authorName: "Lead" },
      { name: "feat/open", sha: sha(2), date: daysAgo(10), login: "ann", authorName: "Ann", aheadBy: 3, behindBy: 1,
        prs: [
          { number: 5, state: "CLOSED", author: "bob", createdAt: "2025-01-01T00:00:00Z" },
          { number: 9, state: "OPEN", author: "ann", createdAt: "2025-03-01T00:00:00Z" }
        ],
        firstCommit: { login: "zed", name: "Zed" } },
      { name: "merged-pr", sha: sha(3), date: daysAgo(100), authorName: "Cat", aheadBy: 0, behindBy: 4,
        prs: [{ number: 7, state: "MERGED", author: "cat", createdAt: "2025-02-01T00:00:00Z", mergedAt: "2025-02-02T00:00:00Z" }] },
      { name: "solo", sha: sha(4), date: daysAgo(90), authorName: "Dee", aheadBy: 2, behindBy: 0,
        firstCommit: { login: null, name: "Dee Name" } },
      { name: "solo-login", sha: sha(5), date: daysAgo(89), aheadBy: 1, firstCommit: { login: "eve", name: "Eve" } },
      { name: "merged-nopr", sha: sha(6), date: daysAgo(200), aheadBy: 0, behindBy: 9 },
      { name: "prot", sha: sha(7), date: daysAgo(5), protected: "rule", aheadBy: 0 },
      { name: "prot2", sha: sha(8), date: daysAgo(5), protected: "update", aheadBy: 0 }
    ]
  };
}

// ---------- loadReport ----------

test("loadReport builds rows from GraphQL and compare", async () => {
  const { client, gh } = setup(sample());
  const progress = [];
  const rep = await load(client, {}, (p) => progress.push(p));

  assert.equal(rep.owner, "o");
  assert.equal(rep.repo, "r");
  assert.equal(rep.defaultBranch, "main");
  assert.equal(rep.private, false);
  assert.equal(rep.canPush, true);
  assert.equal(rep.fetchedAt, new Date(NOW).toISOString());
  assert.deepEqual(rep.warnings, []);
  assert.equal(rep.branches.length, 8);

  const main = byName(rep, "main");
  assert.equal(main.isDefault, true);
  assert.deepEqual(main.deletable, { ok: false, reason: "default" });
  assert.equal(main.mergedIntoDefault, false);
  assert.deepEqual(main.lastCommit, { date: daysAgo(1), authorName: "Lead", authorEmail: "dev@example.test", login: "lead" });

  const open = byName(rep, "feat/open");
  assert.equal(open.sha, sha(2));
  assert.deepEqual(open.pr, { number: 9, state: "OPEN", url: "https://github.test/o/r/pull/9", title: "PR 9", author: "ann", mergedAt: null });
  assert.deepEqual(open.probableCreator, { login: "bob", name: null, source: "pr" }, "oldest PR author");
  assert.equal(open.aheadBy, 3);
  assert.equal(open.behindBy, 1);
  assert.equal(open.mergedIntoDefault, false);
  assert.deepEqual(open.deletable, { ok: true, reason: null });
  assert.deepEqual(open.openPrs, [9]);

  const mp = byName(rep, "merged-pr");
  assert.equal(mp.pr.state, "MERGED");
  assert.equal(mp.pr.mergedAt, "2025-02-02T00:00:00Z");
  assert.equal(mp.mergedIntoDefault, true);
  assert.equal(mp.stale, true);
  assert.equal(mp.ageDays, 100);

  assert.deepEqual(byName(rep, "solo").probableCreator, { login: null, name: "Dee Name", source: "first-commit" });
  assert.deepEqual(byName(rep, "solo-login").probableCreator, { login: "eve", name: "Eve", source: "first-commit" });
  assert.deepEqual(byName(rep, "merged-nopr").probableCreator, { login: null, name: null, source: "none" });

  // stale: ageDays >= staleDays
  assert.equal(byName(rep, "solo").ageDays, 90);
  assert.equal(byName(rep, "solo").stale, true);
  assert.equal(byName(rep, "solo-login").ageDays, 89);
  assert.equal(byName(rep, "solo-login").stale, false);

  assert.deepEqual(byName(rep, "prot").deletable, { ok: false, reason: "protected" });
  assert.deepEqual(byName(rep, "prot2").deletable, { ok: false, reason: "protected" }, "refUpdateRule counts as protection");
  assert.equal(byName(rep, "prot").protected, true);

  // compare calls: per non-default branch, path segments encoded, "/" kept.
  const compares = gh.calls.filter((c) => c.path.includes("/compare/"));
  assert.equal(compares.length, 7);
  assert.ok(compares.some((c) => c.path === "/repos/o/r/compare/main...feat/open" && c.search === "?per_page=1"));

  assert.deepEqual(progress[0], { phase: "branches", done: 8, total: 8 });
  assert.deepEqual(progress[progress.length - 1], { phase: "details", done: 7, total: 7 });
  assert.equal(gh.writes.length, 0);
});

test("loadReport: permissions, private flag and staleDays default", async () => {
  for (const [perm, canPush] of [["ADMIN", true], ["MAINTAIN", true], ["WRITE", true], ["TRIAGE", false], ["READ", false], [null, false]]) {
    const { client } = setup({ viewerPermission: perm || "NONE", private: true, branches: [
      { name: "main", sha: sha(1) }, { name: "x", sha: sha(2), date: daysAgo(90) }] });
    const rep = await R.loadReport(client, { owner: "o", repo: "r", now: NOW });
    assert.equal(rep.canPush, canPush, perm);
    assert.equal(rep.private, true);
    assert.deepEqual(byName(rep, "x").deletable, canPush ? { ok: true, reason: null } : { ok: false, reason: "no-permission" });
    assert.equal(byName(rep, "x").stale, true, "default staleDays is 90");
  }
});

test("loadReport paginates over more than 100 branches", async () => {
  const branches = [{ name: "main", sha: sha(1) }];
  for (let i = 0; i < 250; i++) branches.push({ name: `b${i}`, sha: sha(100 + i), aheadBy: 1 });
  const { client, gh } = setup({ branches });
  const progress = [];
  const rep = await load(client, { concurrency: 8 }, (p) => progress.push(p));
  assert.equal(rep.branches.length, 251);
  assert.equal(new Set(rep.branches.map((b) => b.name)).size, 251);
  const gql = gh.calls.filter((c) => c.url === GRAPHQL);
  assert.equal(gql.length, 3);
  assert.equal(gql[0].body.variables.after, null);
  assert.ok(gql[1].body.variables.after);
  assert.match(gql[0].body.query, /refs\(refPrefix: "refs\/heads\/", first: 100, after: \$after\)/);
  assert.deepEqual(progress.filter((p) => p.phase === "branches").map((p) => p.done), [100, 200, 251]);
  assert.equal(progress.filter((p) => p.phase === "details").pop().done, 250);
});

test("loadReport runs compare with the concurrency limit", async () => {
  const branches = [{ name: "main", sha: sha(1) }];
  for (let i = 0; i < 20; i++) branches.push({ name: `b${i}`, sha: sha(10 + i) });
  const gh = createFakeGitHub({ owner: "o", repo: "r", branches });
  let running = 0, peak = 0;
  const fetchImpl = async (url, init) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    try { return await gh.fetch(url, init); } finally { running--; }
  };
  const client = createClient({ apiBase: API, graphqlUrl: GRAPHQL, fetchImpl });
  await load(client, { concurrency: 3 });
  assert.equal(peak, 3);
});

test("PR selection: newest for pr, oldest for creator, max 10", async () => {
  const prs = [];
  for (let i = 1; i <= 12; i++) prs.push({ number: i, state: i === 12 ? "CLOSED" : "MERGED", author: `u${i}`, createdAt: new Date(Date.UTC(2025, 0, i)).toISOString() });
  const { client } = setup({ branches: [{ name: "main", sha: sha(1) }, { name: "x", sha: sha(2), prs },
    { name: "ghost", sha: sha(3), aheadBy: 1, firstCommit: { login: "fc" }, prs: [{ number: 20, state: "CLOSED", author: null, createdAt: "2025-01-01T00:00:00Z" }] }] });
  const rep = await load(client);
  const x = byName(rep, "x");
  assert.equal(x.pr.number, 12);
  assert.equal(x.pr.state, "CLOSED");
  assert.deepEqual(x.probableCreator, { login: "u3", name: null, source: "pr" }, "oldest of the 10 newest");
  const ghost = byName(rep, "ghost");
  assert.equal(ghost.pr.author, null);
  assert.deepEqual(ghost.probableCreator, { login: "fc", name: null, source: "first-commit" }, "PR without author falls back");
});

test("compare failure adds a warning and keeps the report", async () => {
  const { client } = setup({ branches: [{ name: "main", sha: sha(1) },
    { name: "bad", sha: sha(2), compareError: { status: 404, message: "No common ancestor" } },
    { name: "ok", sha: sha(3), aheadBy: 2, behindBy: 1 }] });
  const rep = await load(client);
  const bad = byName(rep, "bad");
  assert.equal(bad.aheadBy, null);
  assert.equal(bad.behindBy, null);
  assert.equal(bad.mergedIntoDefault, null);
  assert.equal(byName(rep, "ok").aheadBy, 2);
  assert.equal(rep.warnings.length, 1);
  assert.match(rep.warnings[0], /"bad".*No common ancestor/);
});

test("many compare failures are summarized", async () => {
  const branches = [{ name: "main", sha: sha(1) }];
  for (let i = 0; i < 25; i++) branches.push({ name: `b${i}`, sha: sha(10 + i), compareError: { status: 500, message: "boom" } });
  const { client } = setup({ branches });
  const rep = await load(client);
  assert.equal(rep.warnings.length, 21);
  assert.match(rep.warnings[20], /^5 more/);
});

test("details are skipped over the cap unless asked", async () => {
  const branches = [{ name: "main", sha: sha(1) }];
  for (let i = 0; i < R.DETAILS_CAP + 1; i++) branches.push({ name: `b${i}`, sha: sha(10 + i), aheadBy: 1 });
  const { client, gh } = setup({ branches });
  const rep = await load(client);
  assert.equal(rep.branches.length, R.DETAILS_CAP + 2);
  assert.equal(gh.calls.filter((c) => c.path.includes("/compare/")).length, 0);
  assert.equal(rep.warnings.length, 1);
  assert.match(rep.warnings[0], /more than 1000/);
  assert.equal(rep.branches[1].aheadBy, null);

  const again = setup({ branches });
  const full = await load(again.client, { details: true, concurrency: 16 });
  assert.equal(again.gh.calls.filter((c) => c.path.includes("/compare/")).length, R.DETAILS_CAP + 1);
  assert.equal(full.branches[1].aheadBy, 1);
  assert.deepEqual(full.warnings, []);

  const small = setup(sample());
  const off = await load(small.client, { details: false });
  assert.equal(small.gh.calls.filter((c) => c.path.includes("/compare/")).length, 0);
  assert.equal(off.warnings.length, 1);
});

test("loadReport: unknown repo rejects with 404, empty repo has no default", async () => {
  const { client } = setup({ branches: [] });
  await assert.rejects(R.loadReport(client, { owner: "o", repo: "nope", now: NOW }), (e) => e.status === 404);
  const empty = setup({ defaultBranch: null, branches: [] });
  const rep = await load(empty.client);
  assert.equal(rep.defaultBranch, null);
  assert.deepEqual(rep.branches, []);
  assert.equal(rep.warnings.length, 1);
});

test("branch names are encoded per segment", async () => {
  const { client, gh } = setup({ branches: [{ name: "main", sha: sha(1) }, { name: "u/a#b%c", sha: sha(2) }] });
  const rep = await load(client);
  assert.ok(gh.calls.some((c) => c.path === "/repos/o/r/compare/main...u/a%23b%25c"));
  assert.equal(byName(rep, "u/a#b%c").aheadBy, 0);
  assert.equal(R.encodePath("a/b c/#"), "a/b%20c/%23");
});

// ---------- dryRun ----------

test("dryRun: all block reasons and needs-confirm", async () => {
  const cfg = sample();
  cfg.branches.push({ name: "ruled", sha: sha(20), rules: [{ type: "update" }, { type: "deletion" }] });
  cfg.branches.push({ name: "ruled-other", sha: sha(21), rules: [{ type: "non_fast_forward" }] });
  cfg.branches.push({ name: "moved", sha: sha(22) });
  cfg.branches.push({ name: "gone", sha: sha(23) });
  cfg.branches.push({ name: "plain", sha: sha(24) });
  const { client, gh } = setup(cfg);
  const rep = await load(client);
  gh.state.branches.find((b) => b.name === "moved").sha = sha(99);
  gh.state.branches.splice(gh.state.branches.findIndex((b) => b.name === "gone"), 1);

  const names = ["main", "prot", "ruled", "ruled-other", "moved", "gone", "feat/open", "plain", "not-there", "plain"];
  const res = await R.dryRun(client, rep, names);
  const act = Object.fromEntries(res.items.map((i) => [i.name, i]));
  assert.deepEqual(res.items.map((i) => i.name), ["main", "prot", "ruled", "ruled-other", "moved", "gone", "feat/open", "plain", "not-there"]);
  assert.equal(act.main.action, "blocked");
  assert.match(act.main.reason, /default/);
  assert.equal(act.prot.action, "blocked");
  assert.match(act.prot.reason, /protected/);
  assert.equal(act.ruled.action, "blocked");
  assert.match(act.ruled.reason, /ruleset/);
  assert.equal(act["ruled-other"].action, "delete");
  assert.equal(act.moved.action, "blocked");
  assert.match(act.moved.reason, /new commits/);
  assert.equal(act.moved.sha, sha(22));
  assert.equal(act.gone.action, "blocked");
  assert.match(act.gone.reason, /no longer exists/);
  assert.equal(act["feat/open"].action, "needs-confirm");
  assert.match(act["feat/open"].reason, /#9.*closes/);
  assert.deepEqual(act.plain, { name: "plain", sha: sha(24), action: "delete", reason: null });
  assert.equal(act["not-there"].action, "blocked");
  assert.deepEqual(res.counts, { delete: 2, blocked: 6, needsConfirm: 1 });
  assert.equal(gh.writes.length, 0, "dry run never writes");
  assert.ok(gh.calls.some((c) => c.path === "/repos/o/r/rules/branches/ruled" && c.search === "?per_page=100"));
  assert.ok(!gh.calls.some((c) => c.path.includes("/git/ref/heads/main")), "static blocks need no API call");
});

test("dryRun: no push permission and failed checks block", async () => {
  const { client } = setup({ viewerPermission: "READ", branches: [{ name: "main", sha: sha(1) }, { name: "x", sha: sha(2) }] });
  const rep = await load(client);
  const res = await R.dryRun(client, rep, ["x"]);
  assert.equal(res.items[0].action, "blocked");
  assert.match(res.items[0].reason, /push permission/);

  const f = setup({ branches: [{ name: "main", sha: sha(1) }, { name: "x", sha: sha(2) }, { name: "y", sha: sha(3) }],
    failures: { "GET /repos/o/r/rules/branches/x": { status: 403, message: "Forbidden" },
      "GET /repos/o/r/rules/branches/y": { status: 404, message: "Not Found" } } });
  const rep2 = await load(f.client);
  const res2 = await R.dryRun(f.client, rep2, ["x", "y"]);
  assert.equal(res2.items[0].action, "blocked");
  assert.match(res2.items[0].reason, /rulesets.*Forbidden/);
  assert.equal(res2.items[1].action, "delete", "no rulesets endpoint (old GHES) means no rules");
});

// ---------- deleteBranches ----------

test("deleteBranches: deleted, changed, gone, failed", async () => {
  const { client, gh } = setup({ branches: [
    { name: "main", sha: sha(1) }, { name: "a/b", sha: sha(2) }, { name: "moved", sha: sha(3) },
    { name: "err", sha: sha(4) }],
  failures: { "DELETE /repos/o/r/git/refs/heads/err": { status: 422, message: "Validation Failed" } } });
  const seen = [];
  const res = await R.deleteBranches(client, { owner: "o", repo: "r" }, [
    { name: "a/b", sha: sha(2) },
    { name: "moved", sha: sha(30) },
    { name: "gone", sha: sha(5) },
    { name: "err", sha: sha(4) },
    { name: "bad..name", sha: sha(6) }
  ], (r) => seen.push(r.status));
  assert.deepEqual(res.map((r) => r.status), ["deleted", "changed", "gone", "failed", "failed"]);
  assert.deepEqual(seen, ["deleted", "changed", "gone", "failed", "failed"]);
  assert.equal(res[0].error, null);
  assert.equal(res[3].error, "Validation Failed");
  assert.ok(res[1].error);
  const deletes = gh.writes.filter((w) => w.method === "DELETE").map((w) => w.path);
  assert.deepEqual(deletes, ["/repos/o/r/git/refs/heads/a/b", "/repos/o/r/git/refs/heads/err"], "no DELETE for changed or gone");
  assert.ok(!gh.state.branches.some((b) => b.name === "a/b"));
  assert.ok(gh.state.branches.some((b) => b.name === "moved"));
  // Each delete is preceded by a fresh GET of the ref.
  const i = gh.calls.findIndex((c) => c.method === "DELETE");
  assert.equal(gh.calls[i - 1].path, "/repos/o/r/git/ref/heads/a/b");
});

test("deleteBranches: 422 'does not exist' on DELETE means gone", async () => {
  const { client } = setup({ branches: [{ name: "main", sha: sha(1) }, { name: "x", sha: sha(2) }],
    failures: { "DELETE /repos/o/r/git/refs/heads/x": { status: 422, message: "Reference does not exist" } } });
  const res = await R.deleteBranches(client, { owner: "o", repo: "r" }, [{ name: "x", sha: sha(2) }]);
  assert.equal(res[0].status, "gone");
});

test("deleteBranches runs one at a time", async () => {
  const branches = [{ name: "main", sha: sha(1) }];
  for (let i = 0; i < 5; i++) branches.push({ name: `b${i}`, sha: sha(10 + i) });
  const gh = createFakeGitHub({ owner: "o", repo: "r", branches });
  let running = 0, peak = 0;
  const fetchImpl = async (u, init) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 1)); try { return await gh.fetch(u, init); } finally { running--; } };
  const client = createClient({ apiBase: API, fetchImpl });
  const res = await R.deleteBranches(client, { owner: "o", repo: "r" }, branches.slice(1));
  assert.ok(res.every((r) => r.status === "deleted"));
  assert.equal(peak, 1);
});

// ---------- restoreBranches ----------

test("restoreBranches: restored, exists, invalid, failed", async () => {
  const { client, gh } = setup({ branches: [{ name: "main", sha: sha(1) }, { name: "here", sha: sha(2) }], knownShas: [sha(50)] });
  const seen = [];
  const res = await R.restoreBranches(client, { owner: "o", repo: "r" }, [
    { name: "back/again", sha: sha(50) },
    { name: "here", sha: sha(50) },
    { name: "bad name", sha: sha(50) },
    { name: "ok", sha: "xyz" },
    { name: "lost", sha: sha(77) }
  ], (r) => seen.push(r.name));
  assert.deepEqual(res.map((r) => r.status), ["restored", "exists", "invalid", "invalid", "failed"]);
  assert.deepEqual(seen, ["back/again", "here", "bad name", "ok", "lost"]);
  assert.match(res[4].error, /may no longer exist/);
  const posts = gh.writes.filter((w) => w.method === "POST");
  assert.deepEqual(posts.map((p) => p.body), [
    { ref: "refs/heads/back/again", sha: sha(50) },
    { ref: "refs/heads/lost", sha: sha(77) }
  ], "never POST over an existing branch");
  assert.equal(gh.state.branches.find((b) => b.name === "here").sha, sha(2));
  assert.equal(gh.state.branches.find((b) => b.name === "back/again").sha, sha(50));
});

test("restoreBranches: race on create gives exists, other errors fail", async () => {
  const { client } = setup({ branches: [{ name: "main", sha: sha(1) }],
    failures: { "POST /repos/o/r/git/refs": { status: 422, message: "Reference already exists" },
      "GET /repos/o/r/git/ref/heads/boom": { status: 500, message: "Server Error" } } });
  const res = await R.restoreBranches(client, { owner: "o", repo: "r" }, [{ name: "x", sha: sha(1) }, { name: "boom", sha: sha(1) }]);
  assert.equal(res[0].status, "exists");
  assert.equal(res[1].status, "failed");
  assert.equal(res[1].error, "Server Error");
});

// ---------- CSV / JSON ----------

function csvReport() {
  const row = (over) => Object.assign({
    name: "x", sha: sha(2), isDefault: false, protected: false,
    lastCommit: { date: "2025-01-01T00:00:00Z", authorName: "Ann", authorEmail: "a@x", login: "ann" },
    pr: null, aheadBy: 1, behindBy: 2, mergedIntoDefault: false,
    probableCreator: { login: "ann", name: null, source: "pr" }, ageDays: 3, stale: false,
    deletable: { ok: true, reason: null }
  }, over);
  return {
    owner: "o", repo: "r", defaultBranch: "main", fetchedAt: "2025-06-01T00:00:00.000Z", canPush: true, private: false, warnings: [],
    branches: [
      row({ name: "main", sha: sha(1), isDefault: true, aheadBy: 0, behindBy: 0 }),
      row({ name: "a,b\"c", lastCommit: { date: null, authorName: "Last, First", authorEmail: null, login: null },
        pr: { number: 4, state: "OPEN", url: "https://github.com/o/r/pull/4", title: "t", author: "ann", mergedAt: null },
        probableCreator: { login: null, name: "Zed", source: "first-commit" } }),
      row({ name: "=HYPERLINK(1)", sha: sha(3), lastCommit: { date: null, authorName: "+cmd", authorEmail: null, login: "@me" },
        aheadBy: null, behindBy: null, mergedIntoDefault: null, ageDays: null, probableCreator: { login: null, name: null, source: "none" } }),
      row({ name: "+plus", sha: sha(4), lastCommit: { date: null, authorName: "-minus", authorEmail: null, login: null } }),
      row({ name: "@at", sha: sha(5), lastCommit: { date: null, authorName: "\tTab", authorEmail: null, login: null } }),
      row({ name: "'quote", sha: sha(6), lastCommit: { date: null, authorName: "\rcr", authorEmail: null, login: null } }),
      row({ name: "'=both", sha: sha(7) })
    ]
  };
}

test("toCsv: header order, quoting, CRLF", () => {
  const csv = R.toCsv(csvReport());
  assert.ok(csv.endsWith("\r\n"));
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "branch,sha,default,protected,last_commit_date,last_committer_login,last_committer_name,probable_creator,creator_source,pr_number,pr_state,pr_url,ahead,behind,merged_into_default,stale,age_days");
  assert.equal(lines[1], `main,${sha(1)},true,false,2025-01-01T00:00:00Z,ann,Ann,ann,pr,,,,0,0,false,false,3`);
  assert.equal(lines[2], `"a,b""c",${sha(2)},false,false,,,"Last, First",Zed,first-commit,4,OPEN,https://github.com/o/r/pull/4,1,2,false,false,3`);
});

test("toCsv: prevents formula injection", () => {
  const rows = R.parseCsv(R.toCsv(csvReport()));
  assert.equal(rows[3][0], "'=HYPERLINK(1)");
  assert.equal(rows[3][5], "'@me");
  assert.equal(rows[3][6], "'+cmd");
  assert.equal(rows[3][12], "", "null becomes empty");
  assert.equal(rows[4][0], "'+plus");
  assert.equal(rows[4][6], "'-minus");
  assert.equal(rows[5][0], "'@at");
  assert.equal(rows[5][6], "'\tTab");
  assert.equal(rows[6][0], "''quote", "a leading quote is escaped too, for a lossless round trip");
  assert.equal(rows[6][6], "'\rcr");
  // A CR inside a cell forces quoting.
  assert.ok(R.toCsv(csvReport()).includes(`"'\rcr"`));
  for (const row of rows.slice(1)) for (const c of row) assert.ok(!/^[=+\-@\t\r]/.test(c), JSON.stringify(c));
});

test("toJson", () => {
  const rep = csvReport();
  const text = R.toJson(rep, "github.com");
  assert.ok(text.includes('\n  "format": "branch-report"'));
  const data = JSON.parse(text);
  assert.deepEqual(Object.keys(data), ["format", "version", "host", "owner", "repo", "defaultBranch", "fetchedAt", "branches"]);
  assert.equal(data.version, 1);
  assert.equal(data.host, "github.com");
  assert.deepEqual(data.branches, rep.branches);
});

// ---------- parseExport ----------

test("parseExport: JSON round trip", () => {
  const rep = csvReport();
  const out = R.parseExport(R.toJson(rep, "ghe.example.com"));
  assert.equal(out.host, "ghe.example.com");
  assert.equal(out.owner, "o");
  assert.equal(out.repo, "r");
  const valid = rep.branches.filter((b) => require("../src/lib.js").isValidBranchName(b.name));
  assert.deepEqual(out.branches, valid.map((b) => ({ name: b.name, sha: b.sha })));
  assert.equal(out.errors.length, rep.branches.length - valid.length);
});

test("parseExport: CSV round trip strips the anti-formula quote", () => {
  const rep = csvReport();
  const out = R.parseExport("﻿" + R.toCsv(rep));
  assert.equal(out.host, null);
  assert.equal(out.owner, null);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.branches, rep.branches.map((b) => ({ name: b.name, sha: b.sha })));
  assert.ok(out.branches.some((b) => b.name === "=HYPERLINK(1)"));
  assert.ok(out.branches.some((b) => b.name === "'quote"));
  assert.ok(out.branches.some((b) => b.name === "'=both"));
});

test("parseExport: LF CSV with other column order and bad rows", () => {
  const text = [
    "SHA,Branch,extra",
    `${sha(1)},ok,1`,
    `${sha(2).toUpperCase()},upper,`,
    "nothex,badsha,",
    `${sha(3)},bad name,`,
    `${sha(4)},ok,dup`,
    "",
    `${sha(5)}`,
    `${sha(6)},"multi`,
    `line",`
  ].join("\n");
  const out = R.parseExport(text);
  assert.deepEqual(out.branches, [{ name: "ok", sha: sha(1) }, { name: "upper", sha: sha(2) }]);
  assert.equal(out.errors.length, 5);
  assert.match(out.errors[0], /Line 4.*SHA/);
  assert.match(out.errors[1], /Line 5.*name/);
  assert.match(out.errors[2], /duplicate/);
});

test("parseExport: rejects unknown input", () => {
  assert.match(R.parseExport("").errors[0], /empty/);
  assert.match(R.parseExport("{bad json").errors[0], /not valid JSON/);
  assert.match(R.parseExport('{"format":"other"}').errors[0], /not a branch report/);
  assert.match(R.parseExport("[1,2]").errors[0], /not a branch report/);
  assert.match(R.parseExport("name,commit\nx,y").errors[0], /header/);
  const j = R.parseExport(JSON.stringify({ format: "branch-report", version: 1, owner: "o", repo: "r",
    branches: [{ name: "a", sha: sha(1) }, null, { name: "b" }, { name: 5, sha: sha(2) }] }));
  assert.deepEqual(j.branches, [{ name: "a", sha: sha(1) }]);
  assert.equal(j.errors.length, 3);
  assert.equal(j.host, null);
});

// ---------- filterRows ----------

test("filterRows by status, search and creator", async () => {
  const { client } = setup(sample());
  const rep = await load(client);
  const names = (f) => R.filterRows(rep.branches, f).map((r) => r.name);
  assert.equal(names({ status: "all" }).length, 8);
  assert.equal(names({}).length, 8);
  assert.deepEqual(names({ status: "open" }), ["feat/open"]);
  assert.deepEqual(names({ status: "merged" }), ["merged-pr"]);
  assert.deepEqual(names({ status: "closed" }), []);
  assert.deepEqual(names({ status: "no-pr" }), ["solo", "solo-login", "merged-nopr", "prot", "prot2"]);
  assert.deepEqual(names({ status: "merged-no-pr" }), ["merged-nopr", "prot", "prot2"]);
  assert.deepEqual(names({ status: "stale" }), ["merged-pr", "solo", "merged-nopr"]);
  assert.deepEqual(names({ search: "OPEN" }), ["feat/open"]);
  assert.deepEqual(names({ search: "dee" }), ["solo"], "commit author name and creator name");
  assert.deepEqual(names({ search: "LEAD" }), ["main"], "login");
  assert.deepEqual(names({ search: "cat" }), ["merged-pr"], "PR author");
  assert.deepEqual(names({ creator: "BOB" }), ["feat/open"]);
  assert.deepEqual(names({ creator: "Dee Name" }), ["solo"]);
  assert.deepEqual(names({ creator: "eve", status: "stale" }), []);
  assert.deepEqual(names({ status: "stale", search: "merged" }), ["merged-pr", "merged-nopr"]);
  assert.equal(R.filterRows(rep.branches, { status: "open" })[0], byName(rep, "feat/open"), "same objects");
});

test("old GHES without refUpdateRule: retries without the field and warns", async () => {
  const queries = [];
  const client = {
    graphql: async (query, vars) => {
      queries.push(query);
      if (/refUpdateRule/.test(query)) throw new Error("Field 'refUpdateRule' doesn't exist on type 'Ref'");
      return { repository: { isPrivate: false, viewerPermission: "WRITE", defaultBranchRef: { name: "main" },
        refs: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ name: "main", branchProtectionRule: null, target: { oid: "a".repeat(40), committedDate: "2026-01-01T00:00:00Z",
            author: { name: "A", email: "a@x", user: { login: "a" } } }, associatedPullRequests: { nodes: [] } }] } } };
    },
    get: async () => { throw new Error("no REST in this test"); }
  };
  const R = require("../src/report-data.js");
  const rep = await R.loadReport(client, { owner: "o", repo: "r", staleDays: 90, now: Date.parse("2026-02-01") });
  assert.equal(rep.branches.length, 1);
  assert.equal(queries.length, 2);
  assert.ok(!/refUpdateRule/.test(queries[1]));
  assert.ok(rep.warnings.some((w) => /protection rules/.test(w)));
});
