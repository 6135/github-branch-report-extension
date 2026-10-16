# Risks and hazards

Read this before you use Branch Report for GitHub, and especially before you delete branches. It tells you what the extension can do with your account, what can go wrong, and how to reduce the risk.

## Summary

| Risk | Severity | What you can do |
|---|---|---|
| Deleted branches can be lost | High | Keep the backup file. Read the dry run before you confirm. |
| Deleting a branch closes its open pull request | High | Leave open-PR branches unticked unless you are sure. |
| The token can write to your repos | High | Use "Public repositories only" when you can. Log out when you are done. |
| "Probable creator" can be wrong | Medium | Do not use it to blame people or as an audit record. |
| The token is stored in the browser | Medium | Do not use the extension on a shared or untrusted computer. |
| Log out does not cancel the token on GitHub | Medium | Revoke the token on GitHub when you stop using the extension. |
| Device code phishing | Medium | Enter a code on GitHub only when you started the login yourself. |
| Exported files contain names and emails | Low | Share exports only with people who may see them. |

## 1. Deleting branches

A deleted branch is only a pointer. The commits stay on GitHub for some time, but GitHub can remove commits that no branch, tag or pull request points to. **Restore works only while the commits still exist.**

The extension protects you with these steps:

1. **Dry run.** Before anything is deleted, you see each branch and what will happen to it: delete, blocked (with the reason), or needs confirmation.
2. **Backup.** The extension downloads a JSON file with the name and commit SHA of each branch, before it deletes anything. Keep this file. **Restore from export** uses it to create the branches again.
3. **Type to confirm.** You must type `owner/repo` to enable the Delete button.
4. **Changed-branch check.** Just before each delete, the extension reads the branch again. If someone pushed to it after the report was made, it is not deleted.

The extension never deletes the default branch, protected branches, or branches that a ruleset protects from deletion.

What the extension cannot protect against:

- Other people's local work. People who have the branch checked out can still push it again. People who expected it to exist will find it gone.
- Tools that use the branch, such as deployments, CI jobs, or links in issues and documents.
- Restore after GitHub has removed the commits. If restore fails with "commit not found", the branch is lost on GitHub. It can only come back from someone's local clone.

## 2. Open pull requests

Deleting the head branch of an open pull request **closes the pull request**. Branches with an open pull request are never selected by "select all". The dry run lists them separately, and you must tick an extra box to delete them.

A restored branch does not reopen a closed pull request by itself. You must reopen it on GitHub.

## 3. Access the extension gets

When you log in, GitHub gives the extension an OAuth token. The token acts as you.

- **"Public repositories only"** gives the `public_repo` scope. The token can change every public repo that you can write to.
- **"Public and private repositories"** gives the `repo` scope. The token can read and change **all** private repos that you can access, in every organization you belong to. GitHub has no smaller OAuth scope for this.
- The token **does not expire**. It works until you revoke it.

The extension uses the token to read branches, commits and pull requests, and to delete and create branches when you ask. The token itself allows more. If someone steals it, they get all of this access.

## 4. "Probable creator" is an estimate

Git does not record who created a branch. The extension shows two columns:

- **Last committer**: the author of the newest commit on the branch. This is exact.
- **Probable creator**: the author of the first pull request from the branch. If there is no pull request, it is the author of the first commit that is not in the default branch. **This is a guess.** It is wrong when someone else pushed the branch, when commits were rebased or cherry-picked, or when the branch has no commits of its own.

Do not use these columns to blame people or as an audit record. For a real audit, organizations on GitHub Enterprise Cloud can use the audit log.

## 5. Where the token is stored

The token is stored in the browser's extension storage (`chrome.storage.local`) as plain text. Browsers do not give extensions an encrypted store.

- Only the extension's own pages and background script read the token. GitHub pages and other extensions cannot read it.
- Any person or program with access to your browser profile files can read it. This includes malware on your computer.

Do not log in on a shared computer.

## 6. Logging out

**Log out** deletes the token from the browser only. The extension cannot cancel it on GitHub, because that needs the OAuth App's client secret, and an extension cannot keep a secret.

To cancel the token, open **GitHub → Settings → Applications → Authorized OAuth Apps**, find **Branch Report for GitHub**, and click **Revoke**.

## 7. Device code phishing

The login uses GitHub's device flow. An attacker can start a login with the same public client ID and send you their code, for example "enter this code to get access". If you enter it, the attacker gets a token with your access, and GitHub shows the name "Branch Report for GitHub".

- Enter a code only when **you** clicked **Log in** a moment before.
- Check that the code on GitHub is the same as the code in the extension's login tab.

The public client ID is not a secret and is not a risk by itself. It gives no access without your approval.

## 8. Exported files

CSV and JSON exports contain branch names, commit SHAs, GitHub logins, and commit author names and email addresses. Treat them like the repo itself. Do not post exports of a private repo in public places.

The CSV export puts a `'` in front of cells that start with `=`, `+`, `-` or `@`, so that spreadsheet programs do not run them as formulas.

## 9. Organizations and GitHub Enterprise Server

- Organizations that restrict third-party apps must approve the OAuth App. Until then, their private repos answer "not found".
- Organizations with SAML single sign-on need you to authorize the token for that organization.
- Your organization may have rules about deleting branches. Check before you clean up shared repos.
- On GitHub Enterprise Server, each host needs its own OAuth App. Get the client ID from your administrator, not from a message.

## 10. Report a security problem

Do not open a public issue for a security problem. Use **Security → Report a vulnerability** on the GitHub repo.
