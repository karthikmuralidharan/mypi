/**
 * Regression tests for the session-manager singleton.
 *
 * The bug these lock down was found by driving the live `debug` tool through pi's
 * own dispatch: launch stopped at entry and a breakpoint was set successfully,
 * then a new user turn arrived and `sessions` reported none — while `ps` still
 * showed the debugpy adapter, launcher and debuggee alive and suspended at that
 * breakpoint. Because the processes were still running, session_shutdown had not
 * fired (it terminates them), which rules out teardown and leaves module
 * re-instantiation: pi replaced the extension runtime, so a module-level `let`
 * holding the manager was reset to null and the running session was orphaned.
 *
 * The load-bearing test is "survives module re-instantiation": it imports a second
 * copy of the module under a cache-busting query and asserts both copies hand back
 * the same manager. That assertion fails if the singleton ever moves back to a
 * module-level variable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearManager, mgr } from "./index.ts";

const MANAGER_KEY = "__mypi_dap_session_manager__";

type Holder = Record<string, unknown>;
type Disposable = { dispose?: () => void };

/** Distinct query per import so the module registry yields a fresh instance. */
let freshCounter = 0;
async function reinstantiateModule() {
  freshCounter += 1;
  return (await import(`./index.ts?reinstantiated=${freshCounter}`)) as {
    mgr: typeof mgr;
    clearManager: typeof clearManager;
  };
}

describe("session manager singleton", () => {
  let saved: unknown;
  const created = new Set<Disposable>();

  beforeEach(() => {
    // Park any real manager so these tests never touch a live debug session.
    saved = (globalThis as Holder)[MANAGER_KEY];
    delete (globalThis as Holder)[MANAGER_KEY];
  });

  afterEach(() => {
    // Dispose test-created managers; each constructor starts a cleanup interval
    // that would otherwise keep the test runner's event loop alive.
    const current = (globalThis as Holder)[MANAGER_KEY] as
      | Disposable
      | undefined;
    if (current) created.add(current);
    for (const m of created) {
      if (m !== saved) m.dispose?.();
    }
    created.clear();

    if (saved === undefined) delete (globalThis as Holder)[MANAGER_KEY];
    else (globalThis as Holder)[MANAGER_KEY] = saved;
  });

  test("returns a stable instance within one module instance", () => {
    const a = mgr();
    const b = mgr();
    expect(a).toBe(b);
  });

  test("publishes the manager on globalThis", () => {
    const m = mgr();
    expect((globalThis as Holder)[MANAGER_KEY]).toBe(m);
  });

  test("adopts a manager that already exists on globalThis", () => {
    const planted = mgr();
    created.add(planted);
    // A fresh call must adopt the planted instance rather than construct a rival.
    expect(mgr()).toBe(planted);
  });

  test("survives module re-instantiation", async () => {
    const first = mgr();
    created.add(first);

    const fresh = await reinstantiateModule();
    // Guard the guard: if the query string stopped producing a distinct module,
    // this test would pass trivially by comparing a function to itself.
    expect(fresh.mgr).not.toBe(mgr);

    expect(fresh.mgr()).toBe(first);
  });

  test("clearManager drops the global entry so the next call rebuilds", () => {
    const first = mgr();
    created.add(first);

    clearManager();
    expect((globalThis as Holder)[MANAGER_KEY]).toBeUndefined();

    const second = mgr();
    created.add(second);
    expect(second).not.toBe(first);
  });

  test("clearManager in one module instance is observed by another", async () => {
    const first = mgr();
    created.add(first);

    const fresh = await reinstantiateModule();
    fresh.clearManager();

    // Teardown must be shared too, or session_shutdown in one instance would
    // leave a stale manager visible to the next.
    expect((globalThis as Holder)[MANAGER_KEY]).toBeUndefined();
    const rebuilt = mgr();
    created.add(rebuilt);
    expect(rebuilt).not.toBe(first);
  });
});
