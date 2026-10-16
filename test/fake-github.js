// Fetch-compatible fake of the GitHub API for the report tests.
// REST base: https://api.test. GraphQL: https://api.test/graphql.
"use strict";

const API = "https://api.test";
const GRAPHQL = "https://api.test/graphql";

// Config:
// { owner, repo, private, viewerPermission, defaultBranch, knownShas: [sha],
//   branches: [{ name, sha, date, authorName, authorEmail, login,
//     protected: false|"rule"|"update",          // branchProtectionRule or refUpdateRule
//     prs: [{ number, state, title, author, mergedAt, createdAt }],
//     aheadBy, behindBy, firstCommit: { login, name }, rules: [{ type }],
//     compareError: { status, message } }],
//   failures: { "METHOD /path": { status, message } } }   // path is the raw (encoded) pathname
function createFakeGitHub(config) {
  const state = {
    owner: config.owner || "o",
    repo: config.repo || "r",
    private: !!config.private,
    viewerPermission: config.viewerPermission || "WRITE",
    defaultBranch: config.defaultBranch === undefined ? "main" : config.defaultBranch,
    branches: (config.branches || []).map((b) => Object.assign({}, b)),
    knownShas: new Set(config.knownShas || []),
    failures: Object.assign({}, config.failures || {})
  };
  for (const b of state.branches) state.knownShas.add(b.sha);
  const calls = [];
  const writes = [];

  const find = (name) => state.branches.find((b) => b.name === name);

  function json(status, body, headers) {
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status, headers: Object.assign({ "content-type": "application/json" }, headers || {})
    });
  }
  const notFound = () => json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" });

  // Decode each segment of a raw path tail ("feat/a%20b" → "feat/a b").
  const decodeTail = (tail) => tail.split("/").map(decodeURIComponent).join("/");

  function prNode(p) {
    return {
      number: p.number,
      state: p.state,
      url: `https://github.test/${state.owner}/${state.repo}/pull/${p.number}`,
      title: p.title || `PR ${p.number}`,
      mergedAt: p.mergedAt || null,
      author: p.author ? { login: p.author } : null
    };
  }

  function refNode(b) {
    const prs = (b.prs || []).slice()
      .sort((x, y) => Date.parse(y.createdAt || 0) - Date.parse(x.createdAt || 0))
      .slice(0, 10)
      .map(prNode);
    return {
      name: b.name,
      branchProtectionRule: b.protected === "rule" || b.protected === true ? { pattern: b.name } : null,
      refUpdateRule: b.protected === "update" ? { pattern: b.name } : null,
      target: {
        oid: b.sha,
        committedDate: b.date || "2024-01-01T00:00:00Z",
        author: {
          name: b.authorName === undefined ? "Dev" : b.authorName,
          email: b.authorEmail === undefined ? "dev@example.test" : b.authorEmail,
          user: b.login ? { login: b.login } : null
        }
      },
      associatedPullRequests: { nodes: prs }
    };
  }

  function graphql(body) {
    const v = (body && body.variables) || {};
    if (v.owner !== state.owner || v.name !== state.repo) {
      return json(200, {
        data: { repository: null },
        errors: [{ type: "NOT_FOUND", path: ["repository"], message: `Could not resolve to a Repository with the name '${v.owner}/${v.name}'.` }]
      });
    }
    // Cursors are opaque on GitHub. Here they are base64 of the next index.
    const start = v.after ? Number(Buffer.from(v.after, "base64").toString("utf8")) : 0;
    const page = state.branches.slice(start, start + 100);
    const end = start + page.length;
    const hasNextPage = end < state.branches.length;
    return json(200, {
      data: {
        repository: {
          isPrivate: state.private,
          viewerPermission: state.viewerPermission,
          defaultBranchRef: state.defaultBranch ? { name: state.defaultBranch } : null,
          refs: {
            totalCount: state.branches.length,
            pageInfo: { hasNextPage, endCursor: page.length ? Buffer.from(String(end)).toString("base64") : null },
            nodes: page.map(refNode)
          }
        }
      }
    });
  }

  function refBody(b) {
    return {
      ref: `refs/heads/${b.name}`,
      node_id: "REF_x",
      url: `${API}/repos/${state.owner}/${state.repo}/git/refs/heads/${b.name}`,
      object: { sha: b.sha, type: "commit", url: `${API}/repos/${state.owner}/${state.repo}/git/commits/${b.sha}` }
    };
  }

  function compare(basehead, query) {
    const [base, head] = basehead.split("...").map(decodeTail);
    const b = find(head);
    if (base !== state.defaultBranch || !find(base) || !b) return notFound();
    if (b.compareError) return json(b.compareError.status, { message: b.compareError.message || "Error" });
    const ahead = b.aheadBy || 0;
    const perPage = Number(query.get("per_page")) || 250;
    const commits = [];
    if (ahead > 0) {
      const fc = b.firstCommit || {};
      commits.push({
        sha: "f".repeat(40),
        commit: { author: { name: fc.name || null, email: "x@example.test", date: "2024-01-01T00:00:00Z" }, message: "first" },
        author: fc.login ? { login: fc.login, id: 1, type: "User" } : null
      });
    }
    return json(200, {
      status: ahead && b.behindBy ? "diverged" : ahead ? "ahead" : b.behindBy ? "behind" : "identical",
      ahead_by: ahead,
      behind_by: b.behindBy || 0,
      total_commits: ahead,
      commits: commits.slice(0, perPage),
      files: []
    });
  }

  async function fakeFetch(url, init) {
    init = init || {};
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url);
    let body;
    if (init.body) body = JSON.parse(init.body);
    const call = { method, url: String(url), path: u.pathname, search: u.search, body };
    calls.push(call);
    if (method !== "GET" && String(url) !== GRAPHQL) writes.push(call);

    if (u.origin !== API) return json(500, { message: "fake: wrong origin" });
    const fail = state.failures[`${method} ${u.pathname}`];
    if (fail) return json(fail.status, { message: fail.message || "Error" });
    if (String(url) === GRAPHQL && method === "POST") return graphql(body);

    const prefix = `/repos/${state.owner}/${state.repo}`;
    if (!u.pathname.startsWith(prefix + "/")) return notFound();
    const rest = u.pathname.slice(prefix.length);
    let m;

    if (method === "GET" && (m = /^\/compare\/(.+)$/.exec(rest))) return compare(m[1], u.searchParams);

    if (method === "GET" && (m = /^\/rules\/branches\/(.+)$/.exec(rest))) {
      const b = find(decodeTail(m[1]));
      const rules = (b && b.rules) || [];
      return json(200, rules.map((r) => Object.assign({ ruleset_source_type: "Repository", ruleset_source: `${state.owner}/${state.repo}`, ruleset_id: 1 }, r)));
    }

    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const b = find(decodeTail(m[1]));
      return b ? json(200, refBody(b)) : notFound();
    }

    if (method === "DELETE" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const name = decodeTail(m[1]);
      const i = state.branches.findIndex((b) => b.name === name);
      if (i < 0) return json(422, { message: "Reference does not exist" });
      state.branches.splice(i, 1);
      return new Response(null, { status: 204 });
    }

    if (method === "POST" && rest === "/git/refs") {
      const ref = String(body && body.ref || "");
      const sha = String(body && body.sha || "");
      if (!ref.startsWith("refs/heads/")) return json(422, { message: "Reference name is not valid" });
      const name = ref.slice("refs/heads/".length);
      if (find(name)) return json(422, { message: "Reference already exists" });
      if (!state.knownShas.has(sha)) return json(422, { message: "Object does not exist" });
      const b = { name, sha, date: "2024-01-01T00:00:00Z" };
      state.branches.push(b);
      return json(201, refBody(b));
    }

    return notFound();
  }

  return { fetch: fakeFetch, calls, writes, state, API, GRAPHQL };
}

// A 40-character hex sha made from a number.
function sha(n) {
  return n.toString(16).padStart(40, "0");
}

module.exports = { createFakeGitHub, sha, API, GRAPHQL };
