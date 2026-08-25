# pi-fff-mode.fish — force FFF (fffind/ffgrep) to replace grep/find outright.
#
# WHY: pi-fff's default mode ("tools-and-ui") registers fffind/ffgrep as
# separate, distinctly-named tools alongside pi's built-in find/grep — the
# model has to choose between them, guided only by the routing table in
# AGENTS.md (a prompt-level default, not a mechanical one).
#
# "override" mode instead registers FFF's implementation under the exact
# names `grep`/`find`, so there is no second tool to choose between — see
# @ff-labs/pi-fff's src/index.ts, resolveToolNames(): mode === "override"
# swaps in OVERRIDE_TOOL_NAMES {grep, find, multi_grep} in place of
# FFF_TOOL_NAMES {ffgrep, fffind, fff-multi-grep}.
#
# Resolution order (verified from source): CLI flag `--fff-mode` > this env
# var > library default ("tools-and-ui"). Set here so override mode applies
# to every pi session without passing a flag each launch.
#
# Auto-sourced by fish from ~/.config/fish/conf.d/ — installed here by
# mypi/bootstrap.sh, versioned at mypi/config/fish/pi-fff-mode.fish.
set -gx PI_FFF_MODE override
