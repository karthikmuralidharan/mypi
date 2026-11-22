# Product one-pager

Draft this with the user before writing the technical spec. Keep the product
spec and its behaviour criteria to about one page.

## Build context before drafting

Read any existing issue and relevant docs. Inspect the current behavior. Look
up facts the repository can answer. Ask the user about choices that affect
scope, requirements, or expected behavior.

If several decisions depend on each other or the user wants a deeper interview,
use `grill-me` or its current upstream skill, `grilling`, when available.
[Upstream grilling guide](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)

Group questions that the user can answer now. Give a recommended answer for
each question. Ask follow-up questions after the decisions they depend on are
settled. Record answers in the one-pager and its behaviour criteria. If the
scope and requirements are clear, draft the one-pager directly.

## Product spec

Start with one sentence that says who the feature is for and what they need to
accomplish.

- **Functional requirements.** State what the feature must do. Describe the
  main result and the failure behavior that matters to the user.
- **Non-functional requirements.** State the relevant performance, security,
  reliability, and usage limits. Use a measurable target when one applies.
  Mark open targets for review.

## Behaviour criteria

Write an observable checklist that a test can use. In each item, use Given for
the starting condition, When for the action, and Then for the expected result.
Describe what the caller can observe through the public interface.

If a write can repeat, stop partway, or overlap another attempt, add criteria
for the cases that apply. State what remains after a failure and what the
caller sees after recovery.

For example, a failed report export can use this criterion.

- [ ] Given a report with no rows, when a user exports it, then the app shows
  that the report is empty and creates no file.

## Markdown template

Use these headings in the shared draft.

```markdown
## Product spec

[Who needs this and what they need to accomplish.]

### Functional requirements

- [Required behavior or result.]

### Non-functional requirements

- [Relevant constraint and any agreed target.]

## Behaviour criteria

- [ ] Given [starting condition], when [action], then [observable result].
```

## Review before approval

- Make sure the requirements reflect what the user agreed to.
- Make sure each criterion gives a test a clear expected result.
- Use the loop's [simple-English guidance](../SKILL.md#write-in-simple-english).
