import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ciStatus,
  computeOpenPrLabel,
  parseChecklist,
  parseClosesIssueNumber,
  parseJiraKey,
  resolveStage,
  stageFromPr,
} from "./stage.ts";

test("parseChecklist counts done/total across mixed markers", () => {
  const body =
    "## Behaviour criteria\n- [x] one\n- [ ] two\n- [X] three\n- [ ] four\n";
  assert.deepEqual(parseChecklist(body), { done: 2, total: 4 });
});

test("parseChecklist returns undefined when there is no checklist", () => {
  assert.equal(parseChecklist("just some prose, no list at all"), undefined);
});

test("parseJiraKey finds the loop skill's marker format", () => {
  assert.equal(
    parseJiraKey("intro\n\nJIRA: SWONE-143\n\nmore text"),
    "SWONE-143",
  );
  assert.equal(parseJiraKey("no marker here"), undefined);
});

test("parseClosesIssueNumber recognizes GitHub's closing keywords", () => {
  assert.equal(parseClosesIssueNumber("This PR closes #42 for real"), 42);
  assert.equal(parseClosesIssueNumber("Fixes #7."), 7);
  assert.equal(parseClosesIssueNumber("resolved #99"), 99);
  assert.equal(parseClosesIssueNumber("see #12 for context"), undefined); // not a closing keyword
});

test("ciStatus classifies an empty rollup as none", () => {
  assert.equal(ciStatus([]), "none");
});

test("ciStatus reports failing when any check has a failure-ish state", () => {
  assert.equal(
    ciStatus([{ state: "SUCCESS" }, { conclusion: "FAILURE" }]),
    "failing",
  );
});

test("ciStatus reports pending when nothing failed but something is in flight", () => {
  assert.equal(
    ciStatus([{ state: "SUCCESS" }, { status: "IN_PROGRESS" }]),
    "pending",
  );
});

test("ciStatus reports passing when everything succeeded", () => {
  assert.equal(
    ciStatus([{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }]),
    "passing",
  );
});

test("computeOpenPrLabel prioritizes CI failure over review state", () => {
  assert.equal(
    computeOpenPrLabel({
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    }),
    "PR open · CI failing",
  );
});

test("computeOpenPrLabel flags changes requested when CI is clean", () => {
  assert.equal(
    computeOpenPrLabel({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
    "PR open · changes requested",
  );
});

test("computeOpenPrLabel reports CI running while checks are still pending", () => {
  assert.equal(
    computeOpenPrLabel({
      reviewDecision: null,
      statusCheckRollup: [{ status: "PENDING" }],
    }),
    "PR open · CI running",
  );
});

test("computeOpenPrLabel reports ship-gate clear once approved and green", () => {
  assert.equal(
    computeOpenPrLabel({
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
    "PR open · ship-gate clear",
  );
});

test("computeOpenPrLabel falls back to awaiting review", () => {
  assert.equal(
    computeOpenPrLabel({
      reviewDecision: null,
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
    "PR open · awaiting review",
  );
});

test("stageFromPr reports merged/closed states regardless of checks", () => {
  const base = {
    number: 1,
    url: "https://x/pr/1",
    body: "",
    reviewDecision: null,
    statusCheckRollup: [],
    title: "t",
  };
  assert.equal(stageFromPr({ ...base, state: "MERGED" }).label, "merged");
  assert.equal(
    stageFromPr({ ...base, state: "CLOSED" }).label,
    "closed (not merged)",
  );
});

test("stageFromPr folds in the linked issue's checklist and JIRA key when provided", () => {
  const pr = {
    number: 1,
    state: "OPEN",
    url: "https://x/pr/1",
    body: "Closes #9",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    title: "t",
  };
  const issue = {
    body: "## Behaviour criteria\n- [x] a\n- [ ] b\n\nJIRA: SP-5\n",
    url: "https://x/issues/9",
  };
  const stage = stageFromPr(pr, issue);
  assert.equal(stage.label, "PR open · ship-gate clear");
  assert.deepEqual(stage.checklist, { done: 1, total: 2 });
  assert.equal(stage.jiraKey, "SP-5");
  assert.equal(stage.url, "https://x/pr/1");
});

// ---- resolveStage: glue, tested with an injected fake `gh` — no network, no real CLI ----

test("resolveStage returns 'no PR yet' when gh finds no matching PR", async () => {
  const stage = await resolveStage("o/r", "feat/x", {
    runGh: async () => "[]",
  });
  assert.equal(stage.label, "no PR yet");
});

test("resolveStage fetches the linked issue when the PR body references one", async () => {
  const calls: string[][] = [];
  const runGh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr") {
      return JSON.stringify([
        {
          number: 5,
          state: "OPEN",
          url: "https://x/pr/5",
          body: "Closes #9",
          reviewDecision: "APPROVED",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
          title: "t",
        },
      ]);
    }
    return JSON.stringify({
      body: "JIRA: SP-1\n- [x] done",
      url: "https://x/issues/9",
    });
  };
  const stage = await resolveStage("o/r", "feat/x", { runGh });
  assert.equal(stage.label, "PR open · ship-gate clear");
  assert.equal(stage.jiraKey, "SP-1");
  assert.ok(calls.some((c) => c[0] === "issue"));
});

test("resolveStage degrades to the PR-only stage when the issue lookup fails", async () => {
  const runGh = async (args: string[]) => {
    if (args[0] === "pr") {
      return JSON.stringify([
        {
          number: 5,
          state: "OPEN",
          url: "https://x/pr/5",
          body: "Closes #9",
          reviewDecision: null,
          statusCheckRollup: [],
          title: "t",
        },
      ]);
    }
    throw new Error("gh issue view failed");
  };
  const stage = await resolveStage("o/r", "feat/x", { runGh });
  assert.equal(stage.label, "PR open · awaiting review");
  assert.equal(stage.jiraKey, undefined);
});

test("resolveStage returns 'unknown' rather than throwing when gh itself fails", async () => {
  const stage = await resolveStage("o/r", "feat/x", {
    runGh: async () => {
      throw new Error("gh: command not found");
    },
  });
  assert.equal(stage.label, "unknown");
});
