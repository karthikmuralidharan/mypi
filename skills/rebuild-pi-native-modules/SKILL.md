---
name: "rebuild-pi-native-modules"
description: "Rebuild pi's native node modules (better-sqlite3, node-pty) after a pi/Node update when context-mode or other tools fail with NODE_MODULE_VERSION ABI mismatch."
version: 1
created: "2026-06-11"
updated: "2026-06-11"
---
## When to Use
Use whenever a pi tool (context-mode, node-pty consumers) fails with an error like "compiled against a different Node.js version using NODE_MODULE_VERSION X ... requires NODE_MODULE_VERSION Y", or as a standard step after updating pi (npm update / pi self-update) or after changing the active Node.js version. The cause is a native module (better-sqlite3, node-pty) compiled against a different Node ABI than the currently running Node.

## Procedure
1. Check the running Node ABI: node -e "console.log(process.versions.modules)" (ABI 137 = Node 24, 147 = newer).
2. Rebuild native modules in pi's npm dir: cd ~/.pi/agent/npm && npm rebuild better-sqlite3
3. Verify it loads against the current ABI: cd ~/.pi/agent/npm && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get(); console.log('ok', process.versions.modules)"
4. Confirm the failing pi tool (e.g. ctx_search) now works.

## Pitfalls
- The mismatch recurs every time the active Node version changes or pi is reinstalled/updated — re-run the rebuild then.
- Rebuild must run inside ~/.pi/agent/npm so it targets pi's node_modules, not the current project.

## Verification
1. node -e require check prints 'ok' with the same ABI number as the running Node.
2. The failing tool returns results instead of the NODE_MODULE_VERSION error.