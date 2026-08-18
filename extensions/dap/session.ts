/**
 * DAP Session Manager — Node.js port (stdio only).
 * Manages debug sessions: launch/attach, breakpoints, execution control, state inspection.
 * @source oh-my-pi packages/coding-agent/src/dap/session.ts
 */

import * as path from "node:path";
import { spawn } from "node:child_process";
import { DapClient } from "./client";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";
import { toErrorMessage } from "./utils";
import type {
  DapAttachArguments,
  DapAttachSessionOptions,
  DapBreakpoint,
  DapBreakpointRecord,
  DapCapabilities,
  DapContinueArguments,
  DapContinueOutcome,
  DapContinueResponse,
  DapDataBreakpoint,
  DapDataBreakpointInfoArguments,
  DapDataBreakpointInfoResponse,
  DapDataBreakpointRecord,
  DapDisassembleArguments,
  DapDisassembledInstruction,
  DapDisassembleResponse,
  DapEvaluateArguments,
  DapEvaluateResponse,
  DapExitedEventBody,
  DapFunctionBreakpoint,
  DapFunctionBreakpointRecord,
  DapInitializeArguments,
  DapInstructionBreakpoint,
  DapInstructionBreakpointRecord,
  DapLaunchArguments,
  DapLaunchSessionOptions,
  DapLoadedSourcesResponse,
  DapModule,
  DapModulesArguments,
  DapModulesResponse,
  DapOutputEventBody,
  DapPauseArguments,
  DapReadMemoryArguments,
  DapReadMemoryResponse,
  DapResolvedAdapter,
  DapRunInTerminalArguments,
  DapRunInTerminalResponse,
  DapScopesArguments,
  DapScopesResponse,
  DapSessionStatus,
  DapSessionSummary,
  DapSetDataBreakpointsArguments,
  DapSetInstructionBreakpointsArguments,
  DapSource,
  DapSourceBreakpoint,
  DapStackFrame,
  DapStackTraceArguments,
  DapStackTraceResponse,
  DapStartDebuggingArguments,
  DapStepArguments,
  DapStopLocation,
  DapStoppedEventBody,
  DapThread,
  DapThreadsResponse,
  DapVariablesArguments,
  DapVariablesResponse,
  DapWriteMemoryArguments,
  DapWriteMemoryResponse,
} from "./types";

// ── Helpers ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function untilAborted<T>(
  signal: AbortSignal | undefined,
  promise: Promise<T>,
): Promise<T> {
  if (!signal) return promise;
  const aborted = new Promise<never>((_, reject) => {
    const h = () =>
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Aborted"),
      );
    if (signal.aborted) h();
    else signal.addEventListener("abort", h, { once: true });
  });
  return Promise.race([promise, aborted]);
}

function normalizePath(p: string): string {
  return path.resolve(p);
}

const IDLE_TIMEOUT_MS = 10 * 60_000;
const CLEANUP_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const STOP_CAPTURE_TIMEOUT_MS = 5_000;
const DIAGNOSTICS_POLL_MS = 100;

// ── Session ────────────────────────────────────────────────────

interface DapSession {
  id: string;
  adapter: DapResolvedAdapter;
  cwd: string;
  program?: string;
  client: DapClient;
  /** The first connection ever made for this session. Immutable, kept around purely so #dispose can close it even after `client` is reassigned to a child (see `#wireClient`'s `startDebugging` handling). */
  parentClient: DapClient;
  /** Every additional connection opened in response to a `startDebugging` reverse request, in connection order. */
  childClients: DapClient[];
  status: DapSessionStatus;
  launchedAt: number;
  lastUsedAt: number;
  breakpoints: Map<string, DapBreakpointRecord[]>;
  functionBreakpoints: DapFunctionBreakpointRecord[];
  instructionBreakpoints: DapInstructionBreakpoint[];
  dataBreakpoints: DapDataBreakpoint[];
  breakpointMutationQueue: Promise<void>;
  outputChunks: string[];
  outputBytes: number;
  outputBufferedBytes: number;
  outputTruncated: boolean;
  stop: DapStopLocation;
  threads: DapThread[];
  lastStackFrames: DapStackFrame[];
  exitCode?: number;
  capabilities?: DapCapabilities;
  initializedSeen: boolean;
  needsConfigurationDone: boolean;
  configurationDoneSent: boolean;
  /**
   * One-shot resolver, (re)created by `#prepareStop` before it races the
   * parent-bound `waitForEvent` promises below. The generic "stopped" /
   * "terminated" / "exited" handlers in `#wireClient` call this directly,
   * regardless of which client (parent or a later-promoted child) actually
   * received the event -- unlike `waitForEvent`, which is bound to one
   * specific `DapClient` instance at the moment it was called.
   *
   * WHY THIS EXISTS: for a multi-session adapter (js-debug's pwa-node), the
   * parent connection never itself receives stopped/terminated/exited -- the
   * real target does, on a connection that does not exist yet when
   * `#prepareStop` runs inside `launch()`. Without this, `launch()`'s only
   * stop-observation mechanism is bound to a connection that will never fire
   * it, so it always falls through to STOP_CAPTURE_TIMEOUT_MS (5s) before
   * even rechecking `s.status` -- and empirically, about 4 times out of 5 on
   * a loaded machine, some OTHER status mutation had already landed by then
   * and the stale "stopped" was lost. Verified by instrumenting both paths:
   * the child's stopped handler fires within ~1s of a real launch, but
   * `launch()` did not act on it until the full parent-side timeout elapsed.
   */
  stopSignal?: () => void;
}

export interface DapOutputSnapshot {
  snapshot: DapSessionSummary;
  output: string;
}

// ── Combined error helpers ─────────────────────────────────────

interface StartFailure {
  rejected: boolean;
  error?: unknown;
  settled?: Promise<void>;
}

function trackStart<T>(promise: Promise<T>, failure: StartFailure): Promise<T> {
  const tracked = promise.catch((e) => {
    failure.rejected = true;
    failure.error = e;
    throw e;
  });
  failure.settled = tracked.then(
    () => {},
    () => {},
  );
  return tracked;
}

function combineErrors(
  cmd: string,
  startErr: unknown,
  configErr: unknown,
): Error {
  const sm = toErrorMessage(startErr),
    cm = toErrorMessage(configErr);
  if (sm === cm) return startErr instanceof Error ? startErr : new Error(sm);
  return new Error(
    `DAP ${cmd} failed: ${sm}\nDAP configurationDone also failed: ${cm}`,
  );
}

async function throwPreferredError(
  cmd: string,
  startFailure: StartFailure,
  configErr: unknown,
): Promise<never> {
  await Promise.race([startFailure.settled ?? Promise.resolve(), sleep(50)]);
  if (startFailure.rejected)
    throw combineErrors(cmd, startFailure.error, configErr);
  throw configErr;
}

const DEBUGPY_MISSING = /No module named ['"]?debugpy['"]?/;
function mapDebugpyMissing(name: string, err: unknown): Error | null {
  if (name !== "debugpy") return null;
  if (!DEBUGPY_MISSING.test(toErrorMessage(err))) return null;
  return new Error(
    "adapter 'debugpy' is not available: install with 'pip install debugpy'",
  );
}

// ── Output truncation ──────────────────────────────────────────

function truncateOutput(s: DapSession, output: string): void {
  if (!output) return;
  const bytes = Buffer.byteLength(output, "utf-8");
  s.outputChunks.push(output);
  s.outputBytes += bytes;
  s.outputBufferedBytes += bytes;
  while (s.outputChunks.length > 1) {
    const fb = Buffer.byteLength(s.outputChunks[0], "utf-8");
    if (s.outputBufferedBytes - fb < MAX_OUTPUT_BYTES) break;
    s.outputChunks.shift();
    s.outputBufferedBytes -= fb;
    s.outputTruncated = true;
  }
  if (s.outputBufferedBytes > MAX_OUTPUT_BYTES && s.outputChunks.length > 0) {
    const front = s.outputChunks[0];
    const excess = s.outputBufferedBytes - MAX_OUTPUT_BYTES;
    s.outputChunks[0] = Buffer.from(front, "utf-8")
      .subarray(excess)
      .toString("utf-8");
    s.outputBufferedBytes = MAX_OUTPUT_BYTES;
    s.outputTruncated = true;
  }
}

// ── Summary ────────────────────────────────────────────────────

function bpCount(m: Map<string, DapBreakpointRecord[]>): number {
  let t = 0;
  for (const v of m.values()) t += v.length;
  return t;
}

/**
 * Reads the live session status through a function boundary.
 *
 * LOCAL FIX: `DapSession.status` is mutated by the async `stopped`/`terminated`
 * event handlers, so it can change across an `await`. Comparing `s.status`
 * directly makes TypeScript narrow it for the rest of the function, and a later
 * re-check is then reported as an impossible comparison (TS2367) even though the
 * runtime value really can have changed. Going through a call defeats that
 * unsound narrowing without deleting a load-bearing guard or casting.
 */
function currentStatus(s: DapSession): DapSessionStatus {
  return s.status;
}

function buildSummary(s: DapSession): DapSessionSummary {
  return {
    id: s.id,
    adapter: s.adapter.name,
    cwd: s.cwd,
    program: s.program,
    status: s.status,
    launchedAt: new Date(s.launchedAt).toISOString(),
    lastUsedAt: new Date(s.lastUsedAt).toISOString(),
    threadId: s.stop.threadId,
    frameId: s.stop.frameId,
    stopReason: s.stop.reason,
    stopDescription: s.stop.description ?? s.stop.text,
    frameName: s.stop.frameName,
    instructionPointerReference: s.stop.instructionPointerReference,
    source: s.stop.source,
    line: s.stop.line,
    column: s.stop.column,
    breakpointFiles: s.breakpoints.size,
    breakpointCount: bpCount(s.breakpoints),
    functionBreakpointCount: s.functionBreakpoints.length,
    outputBytes: s.outputBytes,
    outputTruncated: s.outputTruncated,
    exitCode: s.exitCode,
    needsConfigurationDone:
      s.needsConfigurationDone && !s.configurationDoneSent,
  };
}

// ── DapSessionManager ──────────────────────────────────────────

export class DapSessionManager {
  #sessions = new Map<string, DapSession>();
  #activeSessionId: string | null = null;
  #cleanupTimer?: ReturnType<typeof setInterval>;
  #nextId = 0;

  constructor() {
    this.#startCleanupTimer();
  }

  getActiveSession(): DapSessionSummary | null {
    const s = this.#activeOrNull();
    return s ? buildSummary(s) : null;
  }
  listSessions(): DapSessionSummary[] {
    return [...this.#sessions.values()].map(buildSummary);
  }
  getCapabilities(): DapCapabilities | null {
    return this.#activeOrNull()?.capabilities ?? null;
  }

  // ── Launch / Attach ────────────────────────────────────────

  async launch(
    opts: DapLaunchSessionOptions,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<DapSessionSummary> {
    await this.#ensureSlot();
    const client = await DapClient.spawn({
      adapter: opts.adapter,
      cwd: opts.cwd,
    });
    const session = this.#register(
      client,
      opts.adapter,
      opts.cwd,
      opts.program,
    );
    try {
      session.capabilities = await client.initialize(
        this.#initArgs(opts.adapter),
        signal,
        timeoutMs,
      );
      session.needsConfigurationDone =
        session.capabilities.supportsConfigurationDoneRequest === true;
      const launchArgs: DapLaunchArguments = {
        ...opts.adapter.launchDefaults,
        ...(opts.extraLaunchArguments ?? {}),
        program: opts.program,
        cwd: opts.cwd,
        ...(opts.args === undefined ? {} : { args: opts.args }),
      };
      const stopPromise = this.#prepareStop(
        session,
        signal,
        Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
      );
      const failure: StartFailure = { rejected: false };
      const launchP = trackStart(
        client.sendRequest("launch", launchArgs, signal, timeoutMs),
        failure,
      );
      launchP.catch(() => {});
      try {
        await this.#configDone(session, signal, timeoutMs);
      } catch (e) {
        await throwPreferredError("launch", failure, e);
      }
      await launchP;
      try {
        await untilAborted(signal, stopPromise);
        if (session.status === "stopped")
          await this.#fetchTop(
            session,
            signal,
            Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
          );
      } catch {
        if (session.initializedSeen && session.status === "launching")
          session.status = session.configurationDoneSent
            ? "running"
            : "configuring";
      }
      return buildSummary(session);
    } catch (e) {
      await this.#dispose(session);
      const m = mapDebugpyMissing(opts.adapter.name, e);
      if (m) throw m;
      throw e;
    }
  }

  async attach(
    opts: DapAttachSessionOptions,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<DapSessionSummary> {
    await this.#ensureSlot();
    const client = await DapClient.spawn({
      adapter: opts.adapter,
      cwd: opts.cwd,
    });
    const session = this.#register(client, opts.adapter, opts.cwd);
    try {
      session.capabilities = await client.initialize(
        this.#initArgs(opts.adapter),
        signal,
        timeoutMs,
      );
      session.needsConfigurationDone =
        session.capabilities.supportsConfigurationDoneRequest === true;
      const attachArgs: DapAttachArguments = {
        ...opts.adapter.attachDefaults,
        cwd: opts.cwd,
        ...(opts.pid === undefined
          ? {}
          : { pid: opts.pid, processId: opts.pid }),
        ...(opts.port === undefined ? {} : { port: opts.port }),
        ...(opts.host ? { host: opts.host } : {}),
      };
      const stopPromise = this.#prepareStop(
        session,
        signal,
        Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
      );
      const failure: StartFailure = { rejected: false };
      const attachP = trackStart(
        client.sendRequest("attach", attachArgs, signal, timeoutMs),
        failure,
      );
      attachP.catch(() => {});
      try {
        await this.#configDone(session, signal, timeoutMs);
      } catch (e) {
        await throwPreferredError("attach", failure, e);
      }
      await attachP;
      try {
        await untilAborted(signal, stopPromise);
        if (session.status === "stopped")
          await this.#fetchTop(
            session,
            signal,
            Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
          );
      } catch {
        if (session.initializedSeen && session.status === "launching")
          session.status = session.configurationDoneSent
            ? "running"
            : "configuring";
      }
      return buildSummary(session);
    } catch (e) {
      await this.#dispose(session);
      const m = mapDebugpyMissing(opts.adapter.name, e);
      if (m) throw m;
      throw e;
    }
  }

  // ── Breakpoints ────────────────────────────────────────────

  #serializeBp<T>(
    s: DapSession,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const run = s.breakpointMutationQueue.then(() => {
      if (signal?.aborted)
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("Aborted");
      return fn();
    });
    s.breakpointMutationQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async setBreakpoint(
    file: string,
    line: number,
    condition?: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    return this.#serializeBp(
      this.#touch(),
      async () => {
        const sp = normalizePath(file);
        const cur = [...(this.#touch().breakpoints.get(sp) ?? [])].filter(
          (e) => e.line !== line,
        );
        cur.push({ verified: false, line, condition });
        cur.sort((a, b) => a.line - b.line);
        const r = await this.#req<{ breakpoints?: DapBreakpoint[] }>(
          this.#touch(),
          "setBreakpoints",
          {
            source: { path: sp, name: path.basename(sp) },
            breakpoints: cur.map<DapSourceBreakpoint>((e) => ({
              line: e.line,
              ...(e.condition ? { condition: e.condition } : {}),
            })),
          },
          signal,
          timeoutMs,
        );
        this.#touch().breakpoints.set(sp, this.#mapSrcBps(cur, r?.breakpoints));
        return {
          snapshot: buildSummary(this.#touch()),
          breakpoints: this.#touch().breakpoints.get(sp) ?? [],
          sourcePath: sp,
        };
      },
      signal,
    );
  }

  async removeBreakpoint(
    file: string,
    line: number,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    return this.#serializeBp(
      this.#touch(),
      async () => {
        const sp = normalizePath(file);
        const cur = [...(this.#touch().breakpoints.get(sp) ?? [])].filter(
          (e) => e.line !== line,
        );
        const r = await this.#req<{ breakpoints?: DapBreakpoint[] }>(
          this.#touch(),
          "setBreakpoints",
          {
            source: { path: sp, name: path.basename(sp) },
            breakpoints: cur.map<DapSourceBreakpoint>((e) => ({
              line: e.line,
              ...(e.condition ? { condition: e.condition } : {}),
            })),
          },
          signal,
          timeoutMs,
        );
        if (cur.length === 0) this.#touch().breakpoints.delete(sp);
        else
          this.#touch().breakpoints.set(
            sp,
            this.#mapSrcBps(cur, r?.breakpoints),
          );
        return {
          snapshot: buildSummary(this.#touch()),
          breakpoints: this.#touch().breakpoints.get(sp) ?? [],
          sourcePath: sp,
        };
      },
      signal,
    );
  }

  async setFunctionBreakpoint(
    name: string,
    condition?: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    return this.#serializeBp(
      this.#touch(),
      async () => {
        const s = this.#touch();
        const cur = s.functionBreakpoints.filter((e) => e.name !== name);
        cur.push({ verified: false, name, condition });
        cur.sort((a, b) => a.name.localeCompare(b.name));
        const r = await this.#req<{ breakpoints?: DapBreakpoint[] }>(
          s,
          "setFunctionBreakpoints",
          {
            breakpoints: cur.map<DapFunctionBreakpoint>((e) => ({
              name: e.name,
              ...(e.condition ? { condition: e.condition } : {}),
            })),
          },
          signal,
          timeoutMs,
        );
        s.functionBreakpoints = this.#mapFnBps(cur, r?.breakpoints);
        return {
          snapshot: buildSummary(s),
          breakpoints: s.functionBreakpoints,
        };
      },
      signal,
    );
  }

  async removeFunctionBreakpoint(
    name: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    return this.#serializeBp(
      this.#touch(),
      async () => {
        const s = this.#touch();
        const cur = s.functionBreakpoints.filter((e) => e.name !== name);
        const r = await this.#req<{ breakpoints?: DapBreakpoint[] }>(
          s,
          "setFunctionBreakpoints",
          {
            breakpoints: cur.map<DapFunctionBreakpoint>((e) => ({
              name: e.name,
              ...(e.condition ? { condition: e.condition } : {}),
            })),
          },
          signal,
          timeoutMs,
        );
        s.functionBreakpoints = this.#mapFnBps(cur, r?.breakpoints);
        return {
          snapshot: buildSummary(s),
          breakpoints: s.functionBreakpoints,
        };
      },
      signal,
    );
  }

  async setInstructionBreakpoint(
    ref: string,
    offset?: number,
    condition?: string,
    hitCondition?: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    return this.#serializeBp(
      this.#touch(),
      async () => {
        const s = this.#touch();
        const cur = s.instructionBreakpoints.filter(
          (e) => e.instructionReference !== ref || e.offset !== offset,
        );
        cur.push({
          instructionReference: ref,
          offset,
          condition,
          hitCondition,
        });
        cur.sort(
          (a, b) =>
            a.instructionReference.localeCompare(b.instructionReference) ||
            (a.offset ?? 0) - (b.offset ?? 0),
        );
        await this.#req(
          s,
          "setInstructionBreakpoints",
          { breakpoints: cur } satisfies DapSetInstructionBreakpointsArguments,
          signal,
          timeoutMs,
        );
        s.instructionBreakpoints = cur;
        return { snapshot: buildSummary(s), breakpoints: this.#mapInsBps(cur) };
      },
      signal,
    );
  }

  async removeInstructionBreakpoint(
    ref: string,
    offset?: number,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    return this.#serializeBp(
      this.#touch(),
      async () => {
        const s = this.#touch();
        const cur = s.instructionBreakpoints.filter(
          (e) =>
            !(
              e.instructionReference === ref &&
              (offset === undefined || e.offset === offset)
            ),
        );
        await this.#req(
          s,
          "setInstructionBreakpoints",
          { breakpoints: cur } satisfies DapSetInstructionBreakpointsArguments,
          signal,
          timeoutMs,
        );
        s.instructionBreakpoints = cur;
        return { snapshot: buildSummary(s), breakpoints: this.#mapInsBps(cur) };
      },
      signal,
    );
  }

  async dataBreakpointInfo(
    name: string,
    variablesReference?: number,
    frameId?: number,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const info = await this.#req<DapDataBreakpointInfoResponse>(
      s,
      "dataBreakpointInfo",
      {
        name,
        ...(variablesReference === undefined ? {} : { variablesReference }),
        ...(frameId === undefined ? {} : { frameId }),
      } satisfies DapDataBreakpointInfoArguments,
      signal,
      timeoutMs,
    );
    return { snapshot: buildSummary(s), info };
  }

  async setDataBreakpoint(
    dataId: string,
    accessType?: "read" | "write" | "readWrite",
    condition?: string,
    hitCondition?: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    return this.#serializeBp(
      this.#touch(),
      async () => {
        const s = this.#touch();
        const cur = s.dataBreakpoints.filter((e) => e.dataId !== dataId);
        cur.push({ dataId, accessType, condition, hitCondition });
        cur.sort((a, b) => a.dataId.localeCompare(b.dataId));
        await this.#req(
          s,
          "setDataBreakpoints",
          { breakpoints: cur } satisfies DapSetDataBreakpointsArguments,
          signal,
          timeoutMs,
        );
        s.dataBreakpoints = cur;
        return { snapshot: buildSummary(s), breakpoints: this.#mapDatBps(cur) };
      },
      signal,
    );
  }

  async removeDataBreakpoint(
    dataId: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    return this.#serializeBp(
      this.#touch(),
      async () => {
        const s = this.#touch();
        const cur = s.dataBreakpoints.filter((e) => e.dataId !== dataId);
        await this.#req(
          s,
          "setDataBreakpoints",
          { breakpoints: cur } satisfies DapSetDataBreakpointsArguments,
          signal,
          timeoutMs,
        );
        s.dataBreakpoints = cur;
        return { snapshot: buildSummary(s), breakpoints: this.#mapDatBps(cur) };
      },
      signal,
    );
  }

  // ── Execution control ──────────────────────────────────────

  async continue(
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<DapContinueOutcome> {
    const s = this.#touch();
    const tid = await this.#resolveTid(s, signal, timeoutMs);
    s.stop = {};
    s.lastStackFrames = [];
    s.status = "running";
    const op = this.#prepareStop(s, signal, timeoutMs);
    await this.#req<DapContinueResponse>(
      s,
      "continue",
      { threadId: tid } satisfies DapContinueArguments,
      signal,
      timeoutMs,
    );
    return this.#awaitStop(s, op, signal, timeoutMs);
  }

  async stepOver(signal?: AbortSignal, timeoutMs = 30_000) {
    return this.#step("next", signal, timeoutMs);
  }
  async stepIn(signal?: AbortSignal, timeoutMs = 30_000) {
    return this.#step("stepIn", signal, timeoutMs);
  }
  async stepOut(signal?: AbortSignal, timeoutMs = 30_000) {
    return this.#step("stepOut", signal, timeoutMs);
  }

  async pause(
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<DapSessionSummary> {
    const s = this.#touch();
    if (currentStatus(s) === "stopped") return buildSummary(s);
    const tid = await this.#resolveTid(s, signal, timeoutMs);
    const sp = s.client.waitForEvent<DapStoppedEventBody>(
      "stopped",
      undefined,
      signal,
      timeoutMs,
    );
    sp.catch(() => {});
    await this.#req(
      s,
      "pause",
      { threadId: tid } satisfies DapPauseArguments,
      signal,
      timeoutMs,
    );
    // LOCAL FIX: `s.status` is mutated by the async `stopped` event handler, so it can
    // become "stopped" across the awaits above. TypeScript still narrows it from the
    // early return at the top of this method and reports the comparison as impossible.
    // The runtime check is correct; re-read through a widened alias to defeat the
    // unsound narrowing rather than deleting a load-bearing guard.
    const statusNow: DapSessionStatus = s.status;
    if (statusNow !== "stopped") {
      try {
        await untilAborted(signal, sp);
      } catch {
        /* timeout ok */
      }
    }
    return buildSummary(s);
  }

  async threads(signal?: AbortSignal, timeoutMs = 30_000) {
    const s = this.#touch();
    const r = await this.#req<DapThreadsResponse>(
      s,
      "threads",
      undefined,
      signal,
      timeoutMs,
    );
    s.threads = r?.threads ?? [];
    return { snapshot: buildSummary(s), threads: s.threads };
  }

  async stackTrace(
    frameCount: number | undefined,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const tid = await this.#resolveTid(s, signal, timeoutMs);
    const r = await this.#req<DapStackTraceResponse>(
      s,
      "stackTrace",
      {
        threadId: tid,
        ...(frameCount === undefined ? {} : { levels: frameCount }),
      } satisfies DapStackTraceArguments,
      signal,
      timeoutMs,
    );
    s.lastStackFrames = r?.stackFrames ?? [];
    this.#applyTop(s, s.lastStackFrames[0]);
    return {
      snapshot: buildSummary(s),
      stackFrames: s.lastStackFrames,
      totalFrames: r?.totalFrames,
    };
  }

  async scopes(
    frameId: number | undefined,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const fid = frameId ?? s.stop.frameId;
    if (fid === undefined) throw new Error("No active stack frame.");
    const r = await this.#req<DapScopesResponse>(
      s,
      "scopes",
      { frameId: fid } satisfies DapScopesArguments,
      signal,
      timeoutMs,
    );
    return { snapshot: buildSummary(s), scopes: r?.scopes ?? [] };
  }

  async variables(
    variableRef: number,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const r = await this.#req<DapVariablesResponse>(
      s,
      "variables",
      { variablesReference: variableRef } satisfies DapVariablesArguments,
      signal,
      timeoutMs,
    );
    return { snapshot: buildSummary(s), variables: r?.variables ?? [] };
  }

  async evaluate(
    expression: string,
    context: DapEvaluateArguments["context"],
    frameId: number | undefined,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const fid = frameId ?? s.stop.frameId;
    const r = await this.#req<DapEvaluateResponse>(
      s,
      "evaluate",
      {
        expression,
        context,
        ...(fid === undefined ? {} : { frameId: fid }),
      } satisfies DapEvaluateArguments,
      signal,
      timeoutMs,
    );
    return { snapshot: buildSummary(s), evaluation: r };
  }

  async disassemble(
    memoryRef: string,
    count: number,
    offset?: number,
    instructionOffset?: number,
    resolveSymbols?: boolean,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const r = await this.#req<DapDisassembleResponse>(
      s,
      "disassemble",
      {
        memoryReference: memoryRef,
        instructionCount: count,
        ...(offset === undefined ? {} : { offset }),
        ...(instructionOffset === undefined ? {} : { instructionOffset }),
        ...(resolveSymbols === undefined ? {} : { resolveSymbols }),
      } satisfies DapDisassembleArguments,
      signal,
      timeoutMs,
    );
    return { snapshot: buildSummary(s), instructions: r?.instructions ?? [] };
  }

  async readMemory(
    ref: string,
    count: number,
    offset?: number,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const r = await this.#req<DapReadMemoryResponse>(
      s,
      "readMemory",
      {
        memoryReference: ref,
        count,
        ...(offset === undefined ? {} : { offset }),
      } satisfies DapReadMemoryArguments,
      signal,
      timeoutMs,
    );
    return {
      snapshot: buildSummary(s),
      address: r?.address ?? ref,
      data: r?.data,
      unreadableBytes: r?.unreadableBytes,
    };
  }

  async writeMemory(
    ref: string,
    data: string,
    offset?: number,
    allowPartial?: boolean,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const r = await this.#req<DapWriteMemoryResponse>(
      s,
      "writeMemory",
      {
        memoryReference: ref,
        data,
        ...(offset === undefined ? {} : { offset }),
        ...(allowPartial === undefined ? {} : { allowPartial }),
      } satisfies DapWriteMemoryArguments,
      signal,
      timeoutMs,
    );
    return {
      snapshot: buildSummary(s),
      offset: r?.offset,
      bytesWritten: r?.bytesWritten,
    };
  }

  async modules(
    startMod?: number,
    modCount?: number,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const r = await this.#req<DapModulesResponse>(
      s,
      "modules",
      {
        ...(startMod === undefined ? {} : { startModule: startMod }),
        ...(modCount === undefined ? {} : { moduleCount: modCount }),
      } satisfies DapModulesArguments,
      signal,
      timeoutMs,
    );
    return { snapshot: buildSummary(s), modules: r?.modules ?? [] };
  }

  async loadedSources(signal?: AbortSignal, timeoutMs = 30_000) {
    const s = this.#touch();
    const r = await this.#req<DapLoadedSourcesResponse>(
      s,
      "loadedSources",
      {},
      signal,
      timeoutMs,
    );
    return { snapshot: buildSummary(s), sources: r?.sources ?? [] };
  }

  async customRequest(
    cmd: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const body = await this.#req<unknown>(s, cmd, args, signal, timeoutMs);
    return { snapshot: buildSummary(s), body };
  }

  getOutput(limitBytes?: number): DapOutputSnapshot {
    const s = this.#touch();
    const output = s.outputChunks.join("");
    if (!limitBytes || limitBytes <= 0 || s.outputBufferedBytes <= limitBytes)
      return { snapshot: buildSummary(s), output };
    const buf = Buffer.from(output, "utf-8");
    return buf.length <= limitBytes
      ? { snapshot: buildSummary(s), output }
      : {
          snapshot: buildSummary(s),
          output: buf.subarray(buf.length - limitBytes).toString("utf-8"),
        };
  }

  async terminate(
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<DapSessionSummary | null> {
    const s = this.#activeOrNull();
    if (!s) return null;
    s.lastUsedAt = Date.now();
    if (s.status !== "terminated") {
      if (s.capabilities?.supportsTerminateRequest)
        await untilAborted(
          signal,
          s.client
            .sendRequest("terminate", undefined, signal, timeoutMs)
            .catch(() => {}),
        );
      await untilAborted(
        signal,
        s.client
          .sendRequest(
            "disconnect",
            { terminateDebuggee: true },
            signal,
            timeoutMs,
          )
          .catch(() => {}),
      );
    }
    s.status = "terminated";
    const sum = buildSummary(s);
    await this.#dispose(s);
    return sum;
  }

  dispose(): void {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = undefined;
    }
    for (const s of this.#sessions.values()) {
      void s.client.dispose().catch(() => {});
    }
    this.#sessions.clear();
    this.#activeSessionId = null;
  }

  // ── Private ──────────────────────────────────────────────────

  #startCleanupTimer() {
    this.#cleanupTimer = setInterval(() => {
      this.#cleanup();
    }, CLEANUP_INTERVAL_MS);
    if (typeof this.#cleanupTimer.unref === "function")
      this.#cleanupTimer.unref();
  }

  #cleanup() {
    const now = Date.now();
    for (const s of this.#sessions.values()) {
      if (
        s.status === "terminated" ||
        now - s.lastUsedAt > IDLE_TIMEOUT_MS ||
        !s.client.isAlive()
      ) {
        this.#dispose(s);
      }
    }
  }

  async #ensureSlot() {
    const a = this.#activeOrNull();
    if (!a) return;
    if (a.status === "terminated" || !a.client.isAlive()) {
      await this.#dispose(a);
      return;
    }
    throw new Error(
      `Debug session ${a.id} is still active. Terminate it first.`,
    );
  }

  #register(
    client: DapClient,
    adapter: DapResolvedAdapter,
    cwd: string,
    program?: string,
  ): DapSession {
    const s: DapSession = {
      id: `debug-${++this.#nextId}`,
      adapter,
      cwd,
      program,
      client,
      parentClient: client,
      childClients: [],
      status: "launching",
      launchedAt: Date.now(),
      lastUsedAt: Date.now(),
      breakpoints: new Map(),
      functionBreakpoints: [],
      instructionBreakpoints: [],
      dataBreakpoints: [],
      breakpointMutationQueue: Promise.resolve(),
      outputChunks: [],
      outputBytes: 0,
      outputBufferedBytes: 0,
      outputTruncated: false,
      stop: {},
      threads: [],
      lastStackFrames: [],
      initializedSeen: false,
      needsConfigurationDone: false,
      configurationDoneSent: false,
    };
    this.#wireClient(s, client);
    this.#sessions.set(s.id, s);
    this.#activeSessionId = s.id;
    const hb = setInterval(() => {
      if (!s.client.isAlive()) s.status = "terminated";
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof hb.unref === "function") hb.unref();
    return s;
  }

  /**
   * Registers reverse-request handlers and event listeners on `client`.
   *
   * Called once for a session's initial connection (from `#register`) and
   * again, recursively, for every child connection `startDebugging` opens --
   * see that handler below for why a child needs the exact same wiring a
   * parent does (nested children, e.g. worker_threads, need it too).
   */
  #wireClient(s: DapSession, client: DapClient): void {
    client.onReverseRequest("runInTerminal", async (raw) => {
      const args = (raw ?? {}) as DapRunInTerminalArguments;
      if (!Array.isArray(args.args) || args.args.length === 0)
        throw new Error("runInTerminal: no command");
      const env = {
        ...process.env,
        ...NON_INTERACTIVE_ENV,
        ...Object.fromEntries(
          Object.entries(args.env ?? {}).filter(
            (e): e is [string, string] => e[1] !== null,
          ),
        ),
      };
      const [cmd, ...cmdArgs] = args.args;
      const proc = spawn(cmd, cmdArgs, {
        cwd: args.cwd ?? s.cwd,
        stdio: "pipe",
        detached: true,
        env,
      });
      proc.unref();
      return { processId: proc.pid } satisfies DapRunInTerminalResponse;
    });
    client.onReverseRequest("startDebugging", async (raw) => {
      // vscode-js-debug's `pwa-node`/`pwa-chrome` etc. always launch a lightweight
      // "parent" session that is a pure bootstrapper -- its own `threads` request
      // always answers `[]` (verified against dapDebugServer.js). The actual
      // program, breakpoints, and stops live in a SEPARATE session that the
      // server asks the client to create via this reverse request. Per
      // dapDebugServer.js's own multi-session protocol, that "creation" is just a
      // normal new TCP connection to the SAME port the parent is already using,
      // self-identified by echoing the given `configuration` (which carries a
      // `__pendingTargetId` the server uses to match the new connection to the
      // pending target) back as that new connection's own launch/attach
      // arguments. There is no separate multiplexing handshake beyond that.
      const sa = (raw ?? {}) as Partial<DapStartDebuggingArguments>;
      if (
        (sa.request !== "launch" && sa.request !== "attach") ||
        !sa.configuration ||
        typeof sa.configuration !== "object"
      ) {
        truncateOutput(
          s,
          `[dap] ${s.adapter.name} sent startDebugging with no usable request/configuration; ignoring\n`,
        );
        return {};
      }
      const target = client.socketTarget();
      if (!target) {
        truncateOutput(
          s,
          `[dap] ${s.adapter.name} requested a child debug session, but this connection is stdio-based and cannot host one\n`,
        );
        return {};
      }
      const child = await DapClient.connectChild({
        adapter: s.adapter,
        cwd: s.cwd,
        proc: client.process,
        host: target.host,
        port: target.port,
      });
      this.#wireClient(s, child); // recursive: a child that itself spawns a child (nested workers) needs the same handling
      s.childClients.push(child);
      // Correct DAP protocol order: launch/attach is SENT first, but the
      // adapter deliberately withholds its RESPONSE until configurationDone
      // arrives (dapDebugServer.js: `n.deferred.resolve({})` only after
      // `await e.configurationDone()`). So send launch/attach without awaiting
      // it yet, wait for "initialized", send configurationDone to release the
      // adapter's pending response, THEN await the launch/attach response.
      //
      // An earlier version of this got the order backwards -- sending
      // configurationDone BEFORE launch/attach -- which is wrong in the other
      // direction from the original bug (sending configurationDone too late/
      // never): the adapter cannot resolve a configurationDone gate for a
      // target it has not been told about yet. Both orderings were verified
      // empirically against a hermetic fixture, not assumed: send-launch-first
      // is the one that actually reaches "stopped" reliably.
      const initializedP = child
        .waitForEvent("initialized", undefined, undefined, 5_000)
        .catch(() => {});
      await child.initialize(this.#initArgs(s.adapter));
      const launchP = child.sendRequest(sa.request, sa.configuration);
      launchP.catch(() => {});
      await initializedP;
      await child.sendRequest("configurationDone", {}).catch(() => {});
      await launchP;
      // The child is where the real program/threads/breakpoints live, so it
      // becomes the session's operative client going forward. Last-connected-
      // child-wins: correct for the common single-target case (exactly one
      // child ever connects). A program that spawns more than one debuggable
      // child (e.g. multiple worker_threads) would only expose the most
      // recently connected one through `s.client`; earlier children stay
      // reachable via `s.childClients` but not through the normal request-
      // dispatch path. Documented limitation, not a silent gap.
      s.client = child;
      return {};
    });
    client.onEvent("output", (body) => {
      truncateOutput(s, (body as DapOutputEventBody | undefined)?.output ?? "");
    });
    client.onEvent("initialized", () => {
      s.initializedSeen = true;
      s.status = s.configurationDoneSent ? s.status : "configuring";
    });
    client.onEvent("stopped", (body) => {
      s.status = "stopped";
      const sb = body as DapStoppedEventBody;
      s.stop = {
        threadId: sb.threadId,
        reason: sb.reason,
        description: sb.description,
        text: sb.text,
      };
      s.lastStackFrames = [];
      s.stopSignal?.();
    });
    client.onEvent("continued", (body) => {
      s.status = "running";
      s.stop = { threadId: (body as { threadId?: number }).threadId };
      s.lastStackFrames = [];
    });
    client.onEvent("exited", (body) => {
      s.exitCode = (body as DapExitedEventBody).exitCode;
      s.stopSignal?.();
    });
    client.onEvent("terminated", () => {
      s.status = "terminated";
      s.stopSignal?.();
    });
  }

  #initArgs(adapter: DapResolvedAdapter): DapInitializeArguments {
    return {
      clientID: "piex",
      clientName: "Piex",
      adapterID: adapter.name,
      locale: "en-US",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsRunInTerminalRequest: true,
      supportsStartDebuggingRequest: true,
      supportsMemoryReferences: true,
      supportsVariableType: true,
      supportsInvalidatedEvent: true,
    };
  }

  async #configDone(s: DapSession, signal?: AbortSignal, timeoutMs = 30_000) {
    if (!s.needsConfigurationDone || s.configurationDoneSent) return;
    if (!s.initializedSeen) {
      try {
        await untilAborted(
          signal,
          s.client.waitForEvent("initialized", undefined, signal, timeoutMs),
        );
      } catch {
        return;
      }
    }
    await s.client.sendRequest("configurationDone", {}, signal, timeoutMs);
    s.configurationDoneSent = true;
    if (s.status === "configuring") s.status = "running";
  }

  #applyTop(s: DapSession, f: DapStackFrame | undefined) {
    if (!f) return;
    s.stop.frameId = f.id;
    s.stop.frameName = f.name;
    s.stop.instructionPointerReference = f.instructionPointerReference;
    s.stop.source = f.source;
    s.stop.line = f.line;
    s.stop.column = f.column;
  }

  async #fetchTop(s: DapSession, signal?: AbortSignal, timeoutMs = 5_000) {
    if (s.stop.threadId === undefined) return;
    try {
      const r = await s.client.sendRequest<DapStackTraceResponse>(
        "stackTrace",
        {
          threadId: s.stop.threadId,
          levels: 1,
        } satisfies DapStackTraceArguments,
        signal,
        timeoutMs,
      );
      s.lastStackFrames = r?.stackFrames ?? [];
      this.#applyTop(s, s.lastStackFrames[0]);
    } catch {
      /* ignore */
    }
  }

  async #step(
    cmd: "stepIn" | "stepOut" | "next",
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    const s = this.#touch();
    const tid = await this.#resolveTid(s, signal, timeoutMs);
    s.stop = {};
    s.lastStackFrames = [];
    s.status = "running";
    const op = this.#prepareStop(s, signal, timeoutMs);
    await this.#req(
      s,
      cmd,
      { threadId: tid } satisfies DapStepArguments,
      signal,
      timeoutMs,
    );
    return this.#awaitStop(s, op, signal, timeoutMs);
  }

  #prepareStop(
    s: DapSession,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const { promise: signalP, resolve } = Promise.withResolvers<void>();
    s.stopSignal = resolve;
    const ps = [
      signalP,
      s.client.waitForEvent("stopped", undefined, signal, timeoutMs),
      s.client.waitForEvent("terminated", undefined, signal, timeoutMs),
      s.client.waitForEvent("exited", undefined, signal, timeoutMs),
    ];
    for (const p of ps) p.catch(() => {});
    const o = Promise.race(ps);
    o.catch(() => {});
    return o;
  }

  async #awaitStop(
    s: DapSession,
    op: Promise<unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<DapContinueOutcome> {
    try {
      await untilAborted(signal, op);
      if (s.status === "stopped")
        await this.#fetchTop(s, signal, Math.min(timeoutMs, 5_000));
      const state =
        s.status === "stopped"
          ? "stopped"
          : s.status === "terminated"
            ? "terminated"
            : "running";
      return { snapshot: buildSummary(s), state, timedOut: false };
    } catch {
      if (signal?.aborted)
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("Aborted");
      return {
        snapshot: buildSummary(s),
        state: "running",
        timedOut: s.status === "running",
      };
    }
  }

  async #resolveTid(
    s: DapSession,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<number> {
    if (s.stop.threadId !== undefined) return s.stop.threadId;
    if (s.threads.length > 0) return s.threads[0].id;
    const r = await s.client.sendRequest<DapThreadsResponse>(
      "threads",
      undefined,
      signal,
      timeoutMs,
    );
    s.threads = r?.threads ?? [];
    const tid = s.threads[0]?.id;
    if (tid === undefined) throw new Error("Debugger reported no threads.");
    return tid;
  }

  async #req<T>(
    s: DapSession,
    cmd: string,
    args: unknown,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<T> {
    await this.#configDone(s, signal, timeoutMs);
    const body = await s.client.sendRequest<T>(cmd, args, signal, timeoutMs);
    s.lastUsedAt = Date.now();
    return body;
  }

  #touch(): DapSession {
    const s = this.#activeOrThrow();
    s.lastUsedAt = Date.now();
    if (s.status !== "terminated" && !s.client.isAlive())
      s.status = "terminated";
    return s;
  }

  #activeOrNull(): DapSession | null {
    if (!this.#activeSessionId) return null;
    const s = this.#sessions.get(this.#activeSessionId) ?? null;
    if (!s) this.#activeSessionId = null;
    return s;
  }
  #activeOrThrow(): DapSession {
    const s = this.#activeOrNull();
    if (!s) throw new Error("No active debug session.");
    return s;
  }

  #dispose(s: DapSession) {
    if (this.#activeSessionId === s.id) this.#activeSessionId = null;
    this.#sessions.delete(s.id);
    // s.client may have been reassigned to a child connection (see #wireClient's
    // startDebugging handling) -- dispose it AND the original parent AND every
    // other child, or the connections `s.client` no longer points at leak.
    const clients = new Set<DapClient>([
      s.parentClient,
      s.client,
      ...s.childClients,
    ]);
    for (const c of clients) void c.dispose().catch(() => {});
  }

  #mapSrcBps(
    input: DapBreakpointRecord[],
    rbps?: DapBreakpoint[],
  ): DapBreakpointRecord[] {
    return input.map((e, i) => ({
      line: e.line,
      condition: e.condition,
      id: rbps?.[i]?.id,
      verified: rbps?.[i]?.verified ?? false,
      message: rbps?.[i]?.message,
    }));
  }
  #mapFnBps(
    input: DapFunctionBreakpointRecord[],
    rbps?: DapBreakpoint[],
  ): DapFunctionBreakpointRecord[] {
    return input.map((e, i) => ({
      name: e.name,
      condition: e.condition,
      id: rbps?.[i]?.id,
      verified: rbps?.[i]?.verified ?? false,
      message: rbps?.[i]?.message,
    }));
  }
  #mapInsBps(
    input: DapInstructionBreakpoint[],
  ): DapInstructionBreakpointRecord[] {
    return input.map((e) => ({
      instructionReference: e.instructionReference,
      offset: e.offset,
      condition: e.condition,
      hitCondition: e.hitCondition,
      verified: false,
    }));
  }
  #mapDatBps(input: DapDataBreakpoint[]): DapDataBreakpointRecord[] {
    return input.map((e) => ({
      dataId: e.dataId,
      accessType: e.accessType,
      condition: e.condition,
      hitCondition: e.hitCondition,
      verified: false,
    }));
  }
}
