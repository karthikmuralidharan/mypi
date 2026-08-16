# mypi

My [pi](https://github.com/earendil-works/pi) configuration, version controlled
so a machine can be rebuilt from scratch.

Tracks **configuration and work I authored**. Does not track **data** — memory,
sessions, and caches stay local. See [docs/BOUNDARY.md](docs/BOUNDARY.md) for
exactly where that line sits and why.

## Layout

```text
config/                     declarative pi setup
  settings.json               provider, model, thinking level, packages[]
  mcp.json                    MCP server registrations
  AGENTS.md                   global agent instructions
  npm/package{,-lock}.json    exact pins for all 26 pi extensions
  extensions/                 config for installed extensions
extensions/                 pi extensions I write myself (empty for now)
skills/                     the 7 skills I authored
manifests/
  my-skills.txt               allowlist: my skills vs plugin skills
  agents-skill-lock.json      provenance for third-party ~/.agents/skills
docs/BOUNDARY.md            the config/data boundary, and the reasoning
docs/OMP-PORT-PLAN.md       researched oh-my-pi features worth porting
bootstrap.sh                repo  -> machine  (restore)
sync.sh                     machine -> repo   (capture)
```

## Restore onto a fresh machine

```bash
brew install pi-coding-agent jq   # prerequisites
git clone git@github.com:karthikmuralidharan/mypi.git
cd mypi && ./bootstrap.sh
```

`bootstrap.sh` is idempotent and backs up anything it would overwrite to
`*.pre-bootstrap`. It:

1. writes `config/` into `~/.pi/agent/`
2. installs my authored skills into `~/.pi/agent/skills/`
3. runs `pi install` for every entry in `settings.json` `packages[]`, which
   regenerates the 36 `ce-*` skills and all 67 `agents/*.md`
4. re-clones the third-party skills recorded in `manifests/agents-skill-lock.json`

Flags: `--config` for config only (skip installs), `--force` to skip backups.

Four things it cannot do for you, and it says so on exit: sign in, re-trust
directories, join the tailnet the aperture gateway lives on, and restore memory.

## Capture changes back

After changing anything through pi's UI (adding a package, switching models,
editing a skill):

```bash
./sync.sh
git diff          # review — sync.sh only reads config, never data
git commit -am "add pi-lens, bump default model"
```

## What is deliberately absent

- **Memory.** `MEMORY.md`, `USER.md`, `failures.md`, and per-project memory are
  irreplaceable but are data, not config — different lifecycle, changes every
  session, contains work context. Excluded for now; `docs/BOUNDARY.md` records
  how to add it later if that call changes.
- **Plugin content.** 36 `ce-*` skills and 67 agents are regenerated from
  `settings.json` `packages[]` rather than vendored, to keep diffs clean.
- **Secrets.** `auth.json` is gitignored and was never copied in. Verified with
  a pattern scan before the first commit.
