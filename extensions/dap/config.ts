/**
 * DAP adapter configuration — Node.js port.
 * @source oh-my-pi packages/coding-agent/src/dap/config.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import DEFAULTS from "./defaults.json" with { type: "json" };
import type { DapAdapterConfig, DapResolvedAdapter } from "./types";

const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap"] as const;

// ---------------------------------------------------------------------------
// Inline helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

/** Simple wildcard match for root markers (supports `*` prefix like `*.csproj`). */
function wildcardMatch(pattern: string, filename: string): boolean {
  if (!pattern.includes("*")) return pattern === filename;
  const regex = new RegExp(
    "^" +
      pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$",
  );
  return regex.test(filename);
}

function hasRootMarkers(cwd: string, markers: string[]): boolean {
  let entries: string[] | null = null;
  for (const marker of markers) {
    if (marker.includes("*")) {
      if (entries === null) {
        try {
          entries = fs.readdirSync(cwd);
        } catch {
          entries = [];
        }
      }
      for (const entry of entries) {
        if (wildcardMatch(marker, entry)) return true;
      }
      continue;
    }
    if (fs.existsSync(path.join(cwd, marker))) return true;
  }
  return false;
}

/** Node.js equivalent of Bun.which — finds command on PATH. */
function which(cmd: string): string | null {
  if (path.isAbsolute(cmd) || cmd.startsWith("./") || cmd.startsWith("../")) {
    return fs.existsSync(cmd) ? path.resolve(cmd) : null;
  }
  const PATH = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT?.split(";") ?? [".exe", ".cmd", ".bat"])
      : [""];
  for (const dir of PATH.split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          /* check exec on unix */
        }
        return candidate;
      } catch {
        /* not found, continue */
      }
    }
  }
  return null;
}

function resolveCommand(command: string, cwd: string): string | null {
  const localBinPaths: Array<{ markers: string[]; binDir: string }> = [
    {
      markers: [
        "package.json",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
      ],
      binDir: "node_modules/.bin",
    },
    {
      markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
      binDir: ".venv/bin",
    },
    {
      markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
      binDir: "venv/bin",
    },
    {
      markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
      binDir: ".env/bin",
    },
    { markers: [".venv"], binDir: ".venv/bin" },
    { markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
    { markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
    { markers: ["go.mod", "go.sum"], binDir: "bin" },
  ];

  for (const { markers, binDir } of localBinPaths) {
    if (hasRootMarkers(cwd, markers)) {
      const localPath = path.join(cwd, binDir, command);
      if (fs.existsSync(localPath)) return localPath;
      if (process.platform === "win32") {
        for (const ext of [".exe", ".cmd", ".bat"]) {
          if (fs.existsSync(localPath + ext)) return localPath + ext;
        }
      }
    }
  }
  return which(command);
}

// ---------------------------------------------------------------------------
// Adapter normalization
// ---------------------------------------------------------------------------

function normalizeAdapterConfig(config: unknown): DapAdapterConfig | null {
  if (!isRecord(config)) return null;
  if (typeof config.command !== "string" || config.command.length === 0)
    return null;
  // LOCAL FIX: upstream only whitelisted "socket" here, so any other value was
  // silently dropped to undefined and then defaulted to "stdio" downstream — which
  // is how an adapter on the wrong transport fails with a confusing initialize timeout
  // instead of a config error. Accept every mode the client implements.
  const connectMode =
    config.connectMode === "socket" || config.connectMode === "tcp"
      ? config.connectMode
      : undefined;
  return {
    command: config.command,
    args: normalizeStringArray(config.args),
    languages: normalizeStringArray(config.languages),
    fileTypes: normalizeStringArray(config.fileTypes).map((e) =>
      e.toLowerCase(),
    ),
    rootMarkers: normalizeStringArray(config.rootMarkers),
    launchDefaults: normalizeObject(config.launchDefaults),
    attachDefaults: normalizeObject(config.attachDefaults),
    acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
    ...(connectMode ? { connectMode } : {}),
  };
}

function getDefaults(): Record<string, DapAdapterConfig> {
  const adapters: Record<string, DapAdapterConfig> = {};
  for (const [name, config] of Object.entries(DEFAULTS)) {
    const normalized = normalizeAdapterConfig(config);
    if (normalized) adapters[name] = normalized;
  }
  return adapters;
}

const DEFAULT_ADAPTERS = getDefaults();

// ---------------------------------------------------------------------------
// User configuration layer
//
// LOCAL ADDITION: upstream @piex-dev/dap dropped oh-my-pi's entire user-config
// layer — getAdapterConfigs() returned the bundled defaults and nothing else.
// So adding a language, or fixing a wrong command (upstream invokes bare
// `python`, which does not exist on macOS/homebrew), required editing files
// inside node_modules that any reinstall wipes.
//
// Precedence, low to high: bundled defaults -> user config -> project config.
// Merging is per-adapter and shallow, so overriding one field does not require
// redeclaring the whole adapter.
// ---------------------------------------------------------------------------

/** Explicit path override. Also how tests point at a fixture config. */
const CONFIG_PATH_ENV = "PI_DAP_CONFIG";

function configSearchPaths(cwd: string): string[] {
  const explicit = process.env[CONFIG_PATH_ENV];
  const userPaths = explicit
    ? [explicit]
    : [path.join(os.homedir(), ".pi", "agent", "dap.json")];
  // Project config last so a repo can override the user's global choice.
  return [
    ...userPaths,
    path.join(cwd, ".dap.json"),
    path.join(cwd, "dap.json"),
  ];
}

/**
 * Extract the adapter map from a parsed config file.
 * Accepts both `{ adapters: {...} }` and a bare `{ "<name>": {...} }` map, since
 * both shapes are natural to write and guessing wrong is a silent no-op.
 */
export function extractAdapterMap(parsed: unknown): Record<string, unknown> {
  if (!isRecord(parsed)) return {};
  if (isRecord(parsed.adapters)) return parsed.adapters;
  return parsed;
}

/**
 * Shallow-merge an overlay over a base adapter map.
 *
 * An overlay entry for a known adapter patches it; an entry for an unknown
 * adapter defines a new one and must therefore carry `command`. Invalid entries
 * are skipped rather than throwing: a typo in one adapter must not disable the
 * whole debugger.
 */
export function mergeAdapterConfigs(
  base: Record<string, DapAdapterConfig>,
  overlay: Record<string, unknown>,
): Record<string, DapAdapterConfig> {
  const out: Record<string, DapAdapterConfig> = { ...base };
  for (const [name, patch] of Object.entries(overlay)) {
    if (!isRecord(patch)) continue;
    const existing = out[name];
    const merged = normalizeAdapterConfig(
      existing ? { ...existing, ...patch } : patch,
    );
    if (merged) out[name] = merged;
  }
  return out;
}

function readConfigFile(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {};
    return extractAdapterMap(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    // A malformed config must not break debugging; report and carry on.
    process.stderr.write(
      `dap: ignoring unreadable config ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return {};
  }
}

/** Config depends on cwd, so cache per cwd. Cleared by clearAdapterConfigCache. */
const configCache = new Map<string, Record<string, DapAdapterConfig>>();

/** Test hook: drop cached merges after changing config files or env. */
export function clearAdapterConfigCache(): void {
  configCache.clear();
}

function loadAdapterConfigs(cwd: string): Record<string, DapAdapterConfig> {
  const cached = configCache.get(cwd);
  if (cached) return cached;
  let merged: Record<string, DapAdapterConfig> = { ...DEFAULT_ADAPTERS };
  for (const file of configSearchPaths(cwd)) {
    merged = mergeAdapterConfigs(merged, readConfigFile(file));
  }
  configCache.set(cwd, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAdapterConfigs(
  cwd: string = process.cwd(),
): Record<string, DapAdapterConfig> {
  return { ...loadAdapterConfigs(cwd) };
}

export function normalizeCommandForCwd(command: string, cwd: string): string {
  if (path.isAbsolute(command)) return command;
  if (
    command.startsWith("./") ||
    command.startsWith("../") ||
    command.startsWith(".\\") ||
    command.startsWith("..\\")
  ) {
    return path.resolve(cwd, command);
  }
  return command;
}

export function resolveAdapter(
  adapterName: string,
  cwd: string,
): DapResolvedAdapter | null {
  const config = loadAdapterConfigs(cwd)[adapterName];
  if (!config) return null;
  const resolvedCommand = resolveCommand(
    normalizeCommandForCwd(config.command, cwd),
    cwd,
  );
  if (!resolvedCommand) return null;
  return {
    name: adapterName,
    command: config.command,
    args: config.args ?? [],
    resolvedCommand,
    languages: config.languages ?? [],
    fileTypes: config.fileTypes ?? [],
    rootMarkers: config.rootMarkers ?? [],
    launchDefaults: config.launchDefaults ?? {},
    attachDefaults: config.attachDefaults ?? {},
    connectMode: config.connectMode ?? "stdio",
    acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
  };
}

export function getAvailableAdapters(cwd: string): DapResolvedAdapter[] {
  return Object.keys(DEFAULT_ADAPTERS)
    .map((name) => resolveAdapter(name, cwd))
    .filter((adapter): adapter is DapResolvedAdapter => adapter !== null);
}

function getMatchingAdapters(
  program: string,
  cwd: string,
): DapResolvedAdapter[] {
  const extension = path.extname(program).toLowerCase();
  const available = getAvailableAdapters(cwd);
  if (!extension) {
    // LOCAL FIX: `as const` above makes this Set<"gdb"|"lldb-dap">, so .has(string)
    // is a type error upstream. Widen to string — this is a membership test, not a
    // narrowing site.
    const nativeDebuggers = new Set<string>(EXTENSIONLESS_DEBUGGER_ORDER);
    return available.filter(
      (adapter) =>
        nativeDebuggers.has(adapter.name) ||
        (adapter.rootMarkers.length > 0 &&
          hasRootMarkers(cwd, adapter.rootMarkers)),
    );
  }
  const exactMatches = available.filter((adapter) =>
    adapter.fileTypes.includes(extension),
  );
  if (exactMatches.length > 0) return exactMatches;
  return available;
}

function sortAdaptersForLaunch(
  program: string,
  cwd: string,
  adapters: DapResolvedAdapter[],
): DapResolvedAdapter[] {
  const extension = path.extname(program).toLowerCase();
  const rootAware = adapters.map((adapter) => ({
    adapter,
    hasExtensionMatch:
      extension.length > 0 && adapter.fileTypes.includes(extension),
    hasRootMatch:
      adapter.rootMarkers.length > 0 &&
      hasRootMarkers(cwd, adapter.rootMarkers),
  }));
  rootAware.sort((left, right) => {
    if (left.hasExtensionMatch !== right.hasExtensionMatch)
      return left.hasExtensionMatch ? -1 : 1;
    if (left.hasRootMatch !== right.hasRootMatch)
      return left.hasRootMatch ? -1 : 1;
    const leftRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
      left.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
    );
    const rightRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
      right.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
    );
    const nl = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
    const nr = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
    if (nl !== nr) return nl - nr;
    return left.adapter.name.localeCompare(right.adapter.name);
  });
  return rootAware.map((e) => e.adapter);
}

export type LaunchProgramKind = "file" | "directory" | "missing";

export function selectLaunchAdapter(
  program: string,
  cwd: string,
  adapterName?: string,
  programKind: LaunchProgramKind = "file",
): DapResolvedAdapter | null {
  if (adapterName) return resolveAdapter(adapterName, cwd);
  const matches = getMatchingAdapters(program, cwd);
  const candidates =
    programKind === "directory"
      ? matches.filter((a) => a.acceptsDirectoryProgram)
      : matches;
  const sorted = sortAdaptersForLaunch(
    program,
    cwd,
    candidates.length > 0 ? candidates : matches,
  );
  return sorted[0] ?? null;
}

export function selectAttachAdapter(
  cwd: string,
  adapterName?: string,
  port?: number,
): DapResolvedAdapter | null {
  if (adapterName) return resolveAdapter(adapterName, cwd);
  const available = getAvailableAdapters(cwd);
  if (port !== undefined) {
    const debugpy = available.find((a) => a.name === "debugpy");
    if (debugpy) return debugpy;
  }
  for (const preferred of EXTENSIONLESS_DEBUGGER_ORDER) {
    const match = available.find((a) => a.name === preferred);
    if (match) return match;
  }
  return available[0] ?? null;
}

export function resolveLaunchOverrides(
  adapter: DapResolvedAdapter,
  program: string,
  programKind: LaunchProgramKind,
): Record<string, unknown> {
  if (adapter.name === "dlv") {
    const ext = path.extname(program).toLowerCase();
    if (programKind === "directory" || ext === ".go") return { mode: "debug" };
    if (programKind === "file") return { mode: "exec" };
  }
  return {};
}
