/**
 * Pure formatting helpers for the /loop-stats dashboard. Kept dependency-free
 * so every branch is unit-testable without a terminal or fs access.
 */

export function humanizeDuration(ms: number): string {
 if (!Number.isFinite(ms) || ms < 0) return "0s";
 const totalSeconds = Math.floor(ms / 1000);
 const hours = Math.floor(totalSeconds / 3600);
 const minutes = Math.floor((totalSeconds % 3600) / 60);
 const seconds = totalSeconds % 60;

 if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
 if (minutes > 0)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
 return `${seconds}s`;
}

export function humanizeCount(n: number): string {
 if (!Number.isFinite(n)) return "0";
 const abs = Math.abs(n);
 if (abs < 1000) return String(Math.round(n));
 if (abs < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
 return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function humanizeCost(usd: number): string {
 if (!Number.isFinite(usd)) return "$0.00";
 return `$${usd.toFixed(2)}`;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
 const then = Date.parse(iso);
 if (Number.isNaN(then)) return "unknown";
 const deltaMs = Math.max(0, now - then);
 if (deltaMs < 60_000) return "just now";
 return `${humanizeDuration(deltaMs)} ago`;
}
