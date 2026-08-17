/**
 * Fixture for store.test.ts's concurrency proof. Run as a standalone
 * subprocess (not imported) so N of these launched via child_process.spawn
 * are genuinely separate OS processes contending on the same SQLite file —
 * the actual risk `recordTurn`'s locking has to survive. Reads its inputs
 * from argv so the test controls exactly what each process contributes.
 */
import { recordTurn } from "../store.ts";

const [repoSlug, branch, cwd, durationMs] = process.argv.slice(2);

recordTurn({
 repoSlug,
 branch,
 cwd,
 delta: {
  durationMs: Number(durationMs),
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
  toolCalls: { total: 1, byName: { read: 1 } },
 },
});
