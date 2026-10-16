"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, nextLink } = require("../src/api.js");

function res(status, body, headers) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: headers || {} });
}

test("request sends token and parses JSON", async () => {
  let seen;
  const c = createClient({ apiBase: "https://api.x", token: "t", fetchImpl: async (url, init) => { seen = { url, init }; return res(200, { a: 1 }); } });
  assert.deepEqual(await c.get("/repos/a/b"), { a: 1 });
  assert.equal(seen.url, "https://api.x/repos/a/b");
  assert.equal(seen.init.headers.Authorization, "Bearer t");
});

test("errors carry status and SSO url", async () => {
  const c = createClient({ apiBase: "https://api.x", token: "t",
    fetchImpl: async () => res(403, { message: "SSO" }, { "x-github-sso": "required; url=https://github.com/orgs/o/sso?x=1" }) });
  await assert.rejects(c.get("/x"), (e) => e.status === 403 && e.ssoUrl === "https://github.com/orgs/o/sso?x=1");
});

test("retries after retry-after", async () => {
  let n = 0;
  const c = createClient({ apiBase: "https://api.x", sleep: async () => {},
    fetchImpl: async () => (++n === 1 ? res(403, { message: "slow" }, { "retry-after": "2" }) : res(201, { ok: 1 })) });
  assert.deepEqual(await c.post("/x", {}), { ok: 1 });
  assert.equal(n, 2);
});

test("paginate follows next links", async () => {
  const pages = {
    "https://api.x/l": res(200, [1, 2], { link: '<https://api.x/l?page=2>; rel="next"' }),
    "https://api.x/l?page=2": res(200, [3])
  };
  const c = createClient({ apiBase: "https://api.x", fetchImpl: async (url) => pages[url] });
  assert.deepEqual(await c.paginate("/l"), [1, 2, 3]);
  assert.equal(nextLink('<a>; rel="prev", <b>; rel="next"'), "b");
});

test("token goes only to the API origin", async () => {
  let called = 0;
  const c = createClient({ apiBase: "https://api.x", token: "t", fetchImpl: async () => { called++; return res(200, []); } });
  await assert.rejects(c.get("https://evil.example/steal"), (e) => e.code === "bad_url");
  const pages = createClient({ apiBase: "https://api.x", token: "t",
    fetchImpl: async () => { called++; return res(200, [1], { link: '<https://evil.example/l?page=2>; rel="next"' }); } });
  await assert.rejects(pages.paginate("/l"), (e) => e.code === "bad_url");
  assert.equal(called, 1, "only the first page is fetched");
});

test("SSO url must be https", async () => {
  const c = createClient({ apiBase: "https://api.x", token: "t",
    fetchImpl: async () => res(403, { message: "SSO" }, { "x-github-sso": "required; url=javascript:alert(1)" }) });
  await assert.rejects(c.get("/x"), (e) => e.status === 403 && e.ssoUrl === null);
});

test("graphql posts the query and raises GraphQL errors", async () => {
  let seen;
  const c = createClient({ apiBase: "https://api.x", graphqlUrl: "https://api.x/graphql", token: "t",
    fetchImpl: async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return res(200, { data: { a: 1 } }); } });
  assert.deepEqual(await c.graphql("query { a }", { x: 1 }), { a: 1 });
  assert.equal(seen.url, "https://api.x/graphql");
  assert.deepEqual(seen.body, { query: "query { a }", variables: { x: 1 } });
  const bad = createClient({ apiBase: "https://api.x", graphqlUrl: "https://api.x/graphql",
    fetchImpl: async () => res(200, { errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }) });
  await assert.rejects(bad.graphql("q"), (e) => e.status === 404 && /Could not resolve/.test(e.message));
  const other = createClient({ apiBase: "https://api.x", graphqlUrl: "https://evil.example/graphql", fetchImpl: async () => res(200, {}) });
  await assert.rejects(other.graphql("q"), (e) => e.code === "bad_url");
});
