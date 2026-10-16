// Pure logic. No DOM, no extension APIs. Shared by all scripts and the Node tests.
(function (root) {
  "use strict";

  // OAuth App client ID for github.com. Public value, not a secret.
  // OAuth App "Branch Report for GitHub". Users can override it per host in the settings.
  const DEFAULT_CLIENT_ID = "Ov23liwAZLHm6yVHWYjt";

  const SCOPES = { public: "public_repo", private: "repo" };

  // Files the extension injects on GitHub pages. hosts.js uses this for GHES hosts.
  const CONTENT_SCRIPT = { js: ["src/lib.js", "src/content.js"], css: ["src/content.css"] };

  // A branch with no commit for this many days is "stale".
  const DEFAULT_STALE_DAYS = 90;

  // First path segments that are GitHub pages, not repository owners.
  const RESERVED_OWNERS = new Set([
    "about", "account", "apps", "codespaces", "collections", "contact", "copilot",
    "dashboard", "enterprise", "enterprises", "explore", "features", "issues",
    "login", "logout", "marketplace", "new", "notifications", "orgs", "organizations",
    "pricing", "pulls", "search", "security", "settings", "signup", "sponsors",
    "topics", "trending", "users"
  ]);

  // Returns a lowercase host name ("github.example.com"), or null when not valid.
  // Accepts "host", "https://host", "https://host/path".
  function normalizeHost(input) {
    let s = String(input || "").trim().toLowerCase();
    if (!s) return null;
    if (!/^[a-z]+:\/\//.test(s)) s = "https://" + s;
    let url;
    try { url = new URL(s); } catch (_) { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
    if (host === "api.github.com" || host === "www.github.com") return "github.com";
    return host;
  }

  function isDotCom(host) {
    return host === "github.com";
  }

  function webBase(host) {
    return `https://${host}`;
  }

  function apiBase(host) {
    return isDotCom(host) ? "https://api.github.com" : `https://${host}/api/v3`;
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }

  function repoParts(pathname) {
    const parts = String(pathname || "").split("/").filter(Boolean).map(safeDecode);
    if (parts.length < 2 || RESERVED_OWNERS.has(parts[0].toLowerCase())) return null;
    return parts;
  }

  function graphqlUrl(host) {
    return isDotCom(host) ? "https://api.github.com/graphql" : `https://${host}/api/graphql`;
  }

  // "/o/r/branches" and "/o/r/branches/<view>" → { owner, repo }, else null.
  function parseBranchesPage(pathname) {
    const p = repoParts(pathname);
    if (!p || p[2] !== "branches" || p.length > 4) return null;
    return { owner: p[0], repo: p[1] };
  }

  // Git ref name rules (git check-ref-format), for a branch name.
  function isValidBranchName(name) {
    const s = String(name || "");
    if (!s || s.length > 250) return false;
    if (s.startsWith("/") || s.endsWith("/") || s.endsWith(".") || s.startsWith("-")) return false;
    if (s.includes("..") || s.includes("//") || s.includes("@{") || s === "@") return false;
    if (/[\x00-\x20\x7f~^:?*[\\]/.test(s)) return false;
    return s.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
  }

  const api = {
    DEFAULT_CLIENT_ID, SCOPES, CONTENT_SCRIPT, DEFAULT_STALE_DAYS,
    normalizeHost, isDotCom, webBase, apiBase, graphqlUrl, parseBranchesPage, isValidBranchName
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CpLib = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
