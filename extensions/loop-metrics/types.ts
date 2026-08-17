/**
 * Shared types for the loop-metrics extension.
 *
 * Field names for `TokenUsage`/`CostUsage` mirror pi's own `Usage` type
 * (@earendil-works/pi-ai) so accumulation is a plain field-wise sum with no
 * translation layer.
 */

export interface RepoContext {
 repoRoot: string;
 branch: string;
 repoSlug: string;
}

export interface UsageAmounts {
 input: number;
 output: number;
 cacheRead: number;
 cacheWrite: number;
 total: number;
}

export type TokenUsage = UsageAmounts;
export type CostUsage = UsageAmounts;

export interface ToolCallStats {
 total: number;
 byName: Record<string, number>;
}

export interface TaskStats {
 repoSlug: string;
 branch: string;
 cwd: string;
 firstSeenIso: string;
 lastActiveIso: string;
 durationMs: number;
 turns: number;
 toolCalls: ToolCallStats;
 tokens: TokenUsage;
 cost: CostUsage;
}

export interface TurnDelta {
 durationMs: number;
 tokens: TokenUsage;
 cost: CostUsage;
 toolCalls: ToolCallStats;
}

export function zeroTokens(): TokenUsage {
 return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function zeroCost(): CostUsage {
 return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function zeroToolCalls(): ToolCallStats {
 return { total: 0, byName: {} };
}

export function zeroDelta(): TurnDelta {
 return {
  durationMs: 0,
  tokens: zeroTokens(),
  cost: zeroCost(),
  toolCalls: zeroToolCalls(),
 };
}

export function taskKey(repoSlug: string, branch: string): string {
 return `${repoSlug}::${branch}`;
}
