# Branch Report for GitHub

Browser extension. On a repo's **Branches** page it adds a **Branch report** button. The report lists every branch with its last committer, its probable creator and its pull request status. You can export it as CSV or JSON, delete branches in bulk, and restore deleted branches from an export.

**Read [RISKS.md](RISKS.md) before you delete branches.**

## Use

1. Log in from the extension settings (toolbar icon). Choose "Public and private repositories" for private repos.
2. Open a repo's **Branches** page and click **Branch report**.
3. Filter, search and sort. **Export CSV / JSON** saves the list.
4. **Delete selected** runs a dry run first, downloads a backup file, and asks you to type `owner/repo`.
5. **Restore from export…** creates deleted branches again from a backup or export file.

## Columns

- **Last committer**: author of the newest commit. Exact.
- **Probable creator**: author of the first PR from the branch, else of its first own commit. An estimate.

## Commands

```
npm test        # unit tests
npm run build   # dist/firefox and dist/chromium
npm run lint    # Mozilla add-on linter
npm run package # zips in web-ext-artifacts/
```

Release: push a tag that matches the manifest version, for example `git tag -a v0.1.0 -m "Branch Report 0.1.0" && git push origin v0.1.0`.
