---
name: "chrome-cdp-drive-sync"
description: "Mirror files from an authenticated Google Drive folder to local disk via Chrome DevTools Protocol when direct API access isn't available."
version: 1
created: "2026-07-20"
updated: "2026-07-20"
---
## When to Use
Use when you need to download files from a Google Drive folder the user is logged into, but have no Drive API credentials — driving their real Chrome session via CDP. Also applies to any CDP automation on modern Chrome (v136+).

## Procedure
1. Launch Chrome with the debug port on a SEPARATE profile: osascript -e 'quit app "Google Chrome"'; sleep 3; open -na 'Google Chrome' --args --remote-debugging-port=9222 --remote-allow-origins='*' --user-data-dir="$HOME/.chrome-debug-profile". Both flags are mandatory on v136+.
2. Have the user sign into Google in that window once (the separate profile is NOT their normal login, but persists across restarts).
3. Verify: curl -s http://localhost:9222/json/version (JSON with Browser field = up). /json/list intermittently returns empty [] under load — retry a few times.
4. Open the target folder: curl -s -X PUT 'http://localhost:9222/json/new?<folderURL>'. Confirm document.title via a CDP Runtime.evaluate over the page's webSocketDebuggerUrl.
5. Enumerate files with JS: Array.from(document.querySelectorAll('[data-id][aria-label]')).map(e=>({id:e.getAttribute('data-id'),label:e.getAttribute('aria-label')})). The data-id is the Drive file ID.
6. Download each file by NAVIGATING a dedicated tab to https://drive.google.com/uc?export=download&id=<fileId> after Page.setDownloadBehavior {behavior:'allow', downloadPath:<dir>}. Do NOT use in-page fetch() of that URL — it fails CORS.
7. Verify each download with `file <name>` (real PDF/XLSX/CSV, not an HTML error page) and non-trivial byte size.

## Pitfalls
- Modern Chrome refuses to bind the debug port on the DEFAULT user-data-dir — you MUST pass --user-data-dir pointing at a separate profile, which means it is logged out until the user signs in.
- Without --remote-allow-origins='*' (or the exact origin) every WebSocket handshake returns 403 Forbidden — this silently breaks cdp.mjs and any WS client.
- `open -na 'Google Chrome' --args --remote-debugging-port=...` on an ALREADY-running Chrome just focuses the existing instance and drops the flag; you must fully quit first.
- In-page fetch('https://drive.google.com/uc?export=download&id=...') throws 'Failed to fetch' (CORS) — navigation-based download is the reliable path.
- /json/list can return an empty array transiently; wrap list calls in a retry loop.
- Chrome bundled cdp.mjs may fail with 'WebSocket error' when its cached endpoint is stale — a direct Python websocket-client against the webSocketDebuggerUrl is more robust.

## Verification
1. curl http://localhost:9222/json/version returns valid JSON.
2. A CDP Runtime.evaluate of document.title over the page WS returns the expected page title.
3. `file <download>` reports the true type and byte size matches expectations (not a ~2KB HTML error page).
4. Local file list matches the Drive folder listing exactly.