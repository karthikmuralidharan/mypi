# extensions

pi extensions I write myself. Loaded from `~/.pi/agent/extensions/`.

- **`dap/`** — `debug` tool: a DAP client (launch/breakpoints/stack/scopes/
  evaluate) vendored from `@piex-dev/dap` with upstream defects fixed and a
  user config layer restored.
- **`websearch/`** — `web_research` (OpenAI's built-in web_search via the
  aperture gateway) and `web_fetch` (chrome-stripped page fetch), replacing
  the removed `rpiv-web-tools`.
- **`loop-metrics/`** — `/loop-stats`: per-task AI usage console for
  `/loop`-managed repos. Task identity is the current git branch, scoped to
  repos with `.loop/config.json`; metrics (tokens, cost, duration, tool calls)
  accumulate per turn into a `node:sqlite` store, bucketed by a coarse stage
  (spec/plan, implementing, shipping) derived for free from
  `.loop/state/<branch>.json`, with a JIRA key attributed from the same
  state. The dashboard adds a live, GitHub-derived ship-gate label on top,
  and posts a low-frequency rollup comment (updated in place, never
  per-turn) to the tracked GH issue on each detected stage transition.

Each subdirectory has its own `package.json`/`tsconfig.json`/tests for local
development; only the runtime `.ts` files ship to `~/.pi/agent/extensions/<name>/`
(see `bootstrap.sh`'s exclusion list) — `node_modules`, tests, and fixtures are
dev-only and pi cannot resolve `bun:test`/`node:test` imports anyway.

Not tracked here:

- **Config for installed extensions** (`aperture.json`,
  `pi-rtk-optimizer/config.json`) lives in `../config/extensions/`. Those are
  settings, not code.
- **Tool-managed files** such as `herdr-agent-state.ts`, which declares
  `// installed by herdr; reinstalling or updating the integration overwrites
  this file.` It is gitignored — versioning it would produce a phantom diff on
  every herdr update.

`sync.sh` picks up any `.ts`/`.js` file in `~/.pi/agent/extensions/` whose first
three lines do not say `installed by` or `managed by`, so a new extension lands
here automatically.
