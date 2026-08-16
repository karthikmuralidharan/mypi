---
name: "atlassian-rest-cli"
description: "Access SolarWinds Atlassian (Confluence + Jira) via REST API with curl + jq instead of MCP. Use to read/write Confluence pages (including drafts) and Jira issues on swicloud.atlassian.net."
version: 1
created: "2026-06-08"
updated: "2026-06-08"
---
## When to Use
Use when you need to read or write a specific Confluence page/draft or Jira issue on swicloud.atlassian.net, especially personal-space drafts that Glean cannot index. Prefer Glean for broad cross-product read/search; use this REST path for exact page/issue fetch or writes.

## Procedure
1. Credentials live in ~/.config/fish/config_secrets.fish as ATLASSIAN_EMAIL, ATLASSIAN_SITE (swicloud.atlassian.net), and ATLASSIAN_API_TOKEN (classic ATATT token). bash does not auto-source fish, so read the values from that file when running curl from bash.
2. Auth model is HTTP Basic auth using the email and the API token via curl's -u flag. Classic ATATT tokens inherit the owning user's full Confluence+Jira permissions, including visible drafts.
3. Verify auth by GETting wiki/rest/api/user/current and checking for a 200 plus the expected displayName.
4. Fetch a Confluence page (including draft body) from the v2 endpoint: wiki/api/v2/pages/<PAGE_ID>?body-format=storage, then pull .body.storage.value with jq.
5. Convert the HTML storage value to readable text with a small python3 regex pass.
6. Fetch a Jira issue from rest/api/3/issue/<KEY> and parse with jq.
7. The page ID is the trailing number in the Confluence URL — this also works for /pages/edit-v2/<id> draft links.

## Pitfalls
- A mismatched email/token makes authenticated requests behave like anonymous (404/401 on pages visible in the browser) — the email must be the account that owns the token.
- edit-v2 personal-space drafts ARE retrievable via the v2 pages endpoint with body-format=storage once auth is correct; do not assume drafts are unreachable.
- Glean cannot see personal-space drafts (returns 'Not found or not allowed') — use REST for those.
- Never print the full token; redact when echoing files.

## Verification
1. user/current returns the expected displayName with status 200.
2. rest/api/3/myself returns 200.
3. Target page fetch returns JSON with .title and a populated .body.storage.value.