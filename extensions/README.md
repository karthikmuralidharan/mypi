# extensions

pi extensions I write myself. Loaded from `~/.pi/agent/extensions/`.

Currently empty — I have not written a custom extension yet.

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
