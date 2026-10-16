"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/lib.js");

test("hosts and URLs", () => {
  assert.equal(L.normalizeHost("https://GitHub.com/x"), "github.com");
  assert.equal(L.apiBase("github.com"), "https://api.github.com");
  assert.equal(L.graphqlUrl("github.com"), "https://api.github.com/graphql");
  assert.equal(L.apiBase("ghe.x.com"), "https://ghe.x.com/api/v3");
  assert.equal(L.graphqlUrl("ghe.x.com"), "https://ghe.x.com/api/graphql");
});

test("parseBranchesPage", () => {
  assert.deepEqual(L.parseBranchesPage("/me/repo/branches"), { owner: "me", repo: "repo" });
  assert.deepEqual(L.parseBranchesPage("/me/repo/branches/stale"), { owner: "me", repo: "repo" });
  assert.equal(L.parseBranchesPage("/me/repo"), null);
  assert.equal(L.parseBranchesPage("/me/repo/branches/a/b"), null);
  assert.equal(L.parseBranchesPage("/settings/x/branches"), null);
});

test("isValidBranchName", () => {
  assert.ok(L.isValidBranchName("feature/x-1"));
  for (const bad of ["", "a..b", "a b", "a:b", "x.lock", "/a", "a/"]) assert.ok(!L.isValidBranchName(bad), bad);
});
