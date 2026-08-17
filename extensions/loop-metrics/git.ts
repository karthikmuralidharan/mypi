/**
 * Git repo-context resolution: repo root, current branch, "owner/repo" slug.
 *
 * Deliberately shells out to the real `git` binary rather than parsing
 * `.git/HEAD` by hand — `git rev-parse`/`git remote` already handle worktrees,
 * detached HEAD, and the various remote URL forms correctly.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { RepoContext } from "./types.ts";

function git(cwd: string, args: string[]): string | undefined {
 try {
  return execFileSync("git", args, {
   cwd,
   encoding: "utf8",
   stdio: ["ignore", "pipe", "ignore"],
  }).trim();
 } catch {
  return undefined;
 }
}

/**
 * Parses "owner/repo" out of any common git remote URL form:
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   ssh://git@github.com/owner/repo.git
 */
export function parseRemoteSlug(remoteUrl: string): string | undefined {
 const trimmed = remoteUrl.trim().replace(/\.git$/, "");
 const match = trimmed.match(/[:/]([^/:]+\/[^/]+)$/);
 return match?.[1];
}

/**
 * Resolves the current repo/branch context for `cwd`, or `undefined` when
 * `cwd` is not inside a git repository or HEAD is detached (a detached HEAD
 * has no stable branch name to bucket a task by).
 */
export function getRepoContext(cwd: string): RepoContext | undefined {
 const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
 if (!repoRoot) return undefined;

 const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
 if (!branch || branch === "HEAD") return undefined;

 const remoteUrl = git(cwd, ["remote", "get-url", "origin"]);
 const repoSlug =
  (remoteUrl && parseRemoteSlug(remoteUrl)) || path.basename(repoRoot);

 return { repoRoot, branch, repoSlug };
}
