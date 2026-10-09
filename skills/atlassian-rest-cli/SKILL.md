---
name: "atlassian-rest-cli"
description: "Read and write Confluence pages and Jira issues on swicloud.atlassian.net through the Atlassian MCP server, with a documented REST fallback for personal-space drafts."
version: 2
created: "2026-06-08"
updated: "2026-10-08"
---
## When to Use

Use for any Confluence page or Jira issue on swicloud.atlassian.net. The
Atlassian MCP server is the primary path. Keep the REST fallback for
personal-space drafts, which are not yet confirmed to work over MCP.

Use Glean instead for broad cross-product search. Glean cannot see
personal-space drafts; it returns "Not found or not allowed" for them.

## Primary path: the Atlassian MCP server

The server is configured in `~/.pi/agent/mcp.json` as `atlassian`
(`https://mcp.atlassian.com/v2/mcp`) and authenticates with OAuth. Credentials
live in `~/.pi/agent/mcp-auth.json`. No tokens are needed in the environment.

Its exposure is `deferred`, so the tools are not declared up front. Load them
first with `tool_search`, or call them from a `codemode` script. Tool names are
prefixed `mcp__atlassian__`.

1. Call `getAccessibleAtlassianResources` first. It returns the cloud id that
   the Jira and Confluence tools need.
2. Confluence: `searchConfluence`, `getConfluenceContent`,
   `createConfluenceContent`, `updateConfluenceContent`.
3. Jira: `searchJiraIssuesUsingJql`, `getJiraIssue`, `createJiraIssue`,
   `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`.
4. `atlassianUserInfo` confirms which account the session is acting as.
5. `executeRead`, `executeWrite`, and `executeDestructive` are generic
   escapes. Prefer a specific tool; reach for these only when none fits, and
   treat `executeDestructive` as requiring explicit user approval.

## Fallback path: REST with curl

Use this when MCP cannot reach something, in particular a personal-space draft.

1. Credentials are in `~/.config/fish/config_secrets.fish` as
   `ATLASSIAN_EMAIL`, `ATLASSIAN_SITE` (swicloud.atlassian.net) and
   `ATLASSIAN_API_TOKEN` (a classic `ATATT` token). bash does not source fish,
   so read the values out of that file.
2. Auth is HTTP Basic with the email and token. Classic `ATATT` tokens inherit
   the owning account's full Confluence and Jira permissions, including drafts.
3. A draft page: `wiki/api/v2/pages/<PAGE_ID>?body-format=storage`, then read
   `.body.storage.value`.
4. A Jira issue: `rest/api/3/issue/<KEY>`.
5. The page id is the trailing number in the Confluence URL. This also holds
   for `/pages/edit-v2/<id>` draft links.

`loop/scripts/lib/common.sh` already contains a working Basic-auth Jira client
that reads the same variables. Reuse it rather than writing a new one.

## Pitfalls

- Corporate TLS inspection (Cato Networks) re-signs `mcp.atlassian.com`. Node
  does not trust the Cato root, so MCP fails with a bare `fetch failed` unless
  `NODE_EXTRA_CA_CERTS` points at `~/.config/certs/cato-root.pem`.
- `pi mcp login` rewrites `mcp.json` and drops a hand-set `exposure` value.
  Check it after any login or `/mcp` change.
- On the REST path, a mismatched email and token behaves like an anonymous
  request: 404 or 401 on pages that the browser shows. The email must own the
  token.
- `edit-v2` personal-space drafts **are** retrievable over REST with
  `body-format=storage` once auth is right. Do not assume drafts are
  unreachable.
- Never print a full token. Redact when echoing files.

## Verification

1. `getAccessibleAtlassianResources` returns at least one site with a cloud id.
2. `atlassianUserInfo` reports the expected account.
3. The target fetch returns a populated title and body.
4. On the REST path, `rest/api/3/myself` returns 200.
