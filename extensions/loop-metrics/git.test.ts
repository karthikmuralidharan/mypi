import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getRepoContext, parseRemoteSlug } from "./git.ts";

/**
 * Each test gets its own temp repo, created and destroyed inline rather than
 * via shared beforeEach/afterEach state. `node --test` runs top-level tests
 * within a file concurrently by default (`--test-concurrency`), so a
 * module-level `repoDir` shared across hooks races: one test's afterEach can
 * delete the directory a concurrently-running test is still using, which is
 * exactly what happened on the first version of this file (git commands
 * failing with exit 128 against a directory that had just been rm -rf'd out
 * from under them). Per-test isolation makes that class of bug structurally
 * impossible instead of just less likely.
 */
function withTempRepo(
  fn: (repoDir: string, git: (args: string[]) => void) => void,
): void {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-metrics-git-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
  try {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repoDir, "f.txt"), "x");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    fn(repoDir, git);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

test("parseRemoteSlug handles every common remote URL form", () => {
  assert.equal(parseRemoteSlug("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(
    parseRemoteSlug("https://github.com/owner/repo.git"),
    "owner/repo",
  );
  assert.equal(parseRemoteSlug("https://github.com/owner/repo"), "owner/repo");
  assert.equal(
    parseRemoteSlug("ssh://git@github.com/owner/repo.git"),
    "owner/repo",
  );
  assert.equal(parseRemoteSlug("not a url"), undefined);
});

test("getRepoContext resolves branch and falls back to dir name with no remote", () => {
  withTempRepo((repoDir, git) => {
    git(["checkout", "-q", "-b", "feat/my-task"]);
    const ctx = getRepoContext(repoDir);
    assert.ok(ctx);
    assert.equal(ctx?.branch, "feat/my-task");
    assert.equal(ctx?.repoSlug, path.basename(repoDir));
    assert.equal(ctx?.repoRoot, fs.realpathSync(repoDir));
  });
});

test("getRepoContext prefers the origin remote slug when one exists", () => {
  withTempRepo((repoDir, git) => {
    git([
      "remote",
      "add",
      "origin",
      "git@github.com:karthikmuralidharan/mypi.git",
    ]);
    const ctx = getRepoContext(repoDir);
    assert.equal(ctx?.repoSlug, "karthikmuralidharan/mypi");
  });
});

test("getRepoContext returns undefined for a detached HEAD", () => {
  withTempRepo((repoDir) => {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "-q", sha], {
      cwd: repoDir,
      stdio: "ignore",
    });
    assert.equal(getRepoContext(repoDir), undefined);
  });
});

test("getRepoContext returns undefined outside a git repository", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "loop-metrics-nongit-"));
  try {
    assert.equal(getRepoContext(bare), undefined);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test("getRepoContext resolves from a subdirectory of the repo, not just its root", () => {
  withTempRepo((repoDir, git) => {
    git(["checkout", "-q", "-b", "feat/sub"]);
    const sub = path.join(repoDir, "nested");
    fs.mkdirSync(sub);
    const ctx = getRepoContext(sub);
    assert.equal(ctx?.branch, "feat/sub");
    assert.equal(ctx?.repoRoot, fs.realpathSync(repoDir));
  });
});
