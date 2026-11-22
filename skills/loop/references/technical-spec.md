# Technical spec structure

Read this before writing the technical spec.

Use five sections in order. Write the architecture decision, data models,
interfaces, folder structure, and workflows. Show reviewers what exists today,
what will change, and who needs to act on the change.

## 1. Architecture decision

Name where the new behavior connects to the existing system. Explain how the
parts combine and why that boundary fits the repository.

| | |
| --- | --- |
| Seam added | the interface, parameter or boundary introduced |
| Composes by | wrap, substitute, sequence or inject |
| Call sites touched | how many existing ones change, and why |
| Invariant and owner | what must always be true, and which component owns it |
| Input validation | which boundary validates external data before it enters the model |
| Rejected | what else fitted, and the reason it lost |
| Fits because | the existing convention it matches, cited |
| Costs | what this makes harder later |

### Design principles

- **Favor additive integration.** Keep existing callers working through a
  stable boundary. If a caller must change, name it and explain why.
- **Compose through a stable contract.** Keep the same input and output shape
  when units wrap or replace each other. A second variant can use the same
  boundary without edits to the first variant or its callers.
- **Isolate behavior.** Keep shared state and I/O out of the unit where
  practical. Make independent instances and local tests possible.
- **Name the invariant and its owner.** Give each rule one owner. Show how
  the model, schema, or boundary check enforces it. Validate input where it
  enters the system.
- **Make order explicit.** If the outcome depends on order, state the order and
  the reason for it. Show that order in the workflow.
- **Measure the impact.** Cite repository code or reference searches for the
  caller count. Identify unverified external consumers before approval.
- **Verify the public behavior.** Use the production entry point and real
  in-repo collaborators. Follow the [integration verification](integration-testing.md) guidance.

Use these mechanisms when they fit the boundary.

| Mechanism | Composes by | Add a variant by | Breaks down when |
| --- | --- | --- | --- |
| Interface seam | substitution | a new impl | the iface grows per impl |
| Injected func | substitution | another func | the signature widens |
| Decorator | wrapping | adding a layer | order starts to matter |
| Middleware | sequencing | appending a link | links share state |
| Pipeline stage | sequencing | inserting a stage | a stage reaches back |
| Strategy | substitution | a new strategy | strategies need peers |
| Ports/adapters | swapping edges | another adapter | core imports adapter |
| Event | fan-out | another subscriber | you need the reply |

Explain the cost of any rejected design that matters to this change. Common
costs include mode flags, hidden shared state, and wide interfaces. Also look
for inheritance that fixes how units combine and abstractions with one use.
Explain why a call needs asynchronous delivery before introducing an event.

## 2. Data models

Give each changed entity a heading with `New`, `Modified`, or `Removed` and
the exact type or table name. Show the relevant fields in fenced **Before**
and **After** blocks. Use the project’s language or schema syntax. Include
types, nullability, defaults, and constraints when they affect compatibility.
Show the invariant in the code or schema where possible. Name the component
that enforces it.

For a new entity, show the **After** block. For a removed entity, show the
**Before** block and explain the removal. If no model changes, write
`No changes.` under the section.

#### Modified `Tunnel`

**Before**

```go
type Tunnel struct {
    ID string `json:"id"`
}
```

**After**

```go
type Tunnel struct {
    ID        string `json:"id"`
    AuthzMode string `json:"authzMode,omitempty"`
}
```

- **Compatibility** Existing records omit `authzMode`. Read missing and empty
  values as `legacy`. Verify that older readers accept the optional field.
- **Invariant** The tunnel store returns a supported mode for every record.
  It applies the default on read and rejects unsupported modes on write.
- **Migration** No backfill is required.
- **Rollback** Older readers can read records written by the new version.

## 3. Interfaces

Give each changed contract a heading with its exact name. Apply this to
exported functions, HTTP routes, gRPC methods, CLI options, and published events.
Show the old and new contract in fenced **Before** and **After** blocks. Use
the syntax a caller sees. Include visible error, payload, or default changes.
If the interface accepts external input, state where validation happens and
what a caller sees when input fails validation.

Start a new contract's heading with `New` and show the **After** block.
Start a removed contract's heading with `Removed` and show the **Before**
block and how callers move off it. If no interface changes, write `No changes.`.

#### `ResolveTarget`

**Before**

```go
func ResolveTarget(opts ResolveOptions) string
```

**After**

```go
func ResolveTarget(opts ResolveOptions) (string, error)
```

- **Breaking** Yes. Callers must handle the error return.
- **Consumers** 7 in-repo call sites. Cite the reference search and list the
  affected files. If consumers exist outside the repository, state what you verified.

## 4. Folder structure

Show only paths that change. Mark each line.

```text
internal/
  authz/                 NEW  grant evaluation, no I/O
    grant.go             NEW
    grant_test.go        NEW
  resolver/
    dial.go              MOD  takes an authz.Evaluator
    acl.go               DEL  folded into authz/
cmd/server/
  main.go                MOD  wires the evaluator
```

The tree is where a reviewer sees the pattern made real. If the chosen
pattern was ports and adapters but the tree puts I/O inside the core, that
contradiction is visible here and nowhere else.

## 5. Workflows

Use Mermaid `sequenceDiagram` blocks so GitHub renders the workflows in the
issue. Show the main path and the relevant failure and edge cases.

If a write can stop partway, repeat, or overlap another attempt, show the paths
that apply. State how the system identifies the same operation. Show what is
durable after a partial write and how a retry reaches the expected end state.
If two attempts can overlap, show who owns the shared write and what each
caller receives. Record those outcomes in the behaviour criteria.

If the change carries production rollout risk, name the rollout owner and
the signals that show the rollout is healthy. State the conditions for stopping
or rolling it back and how to restore service.

## Implementation plan

Put the work checklist in `## Plan` in the shared draft. Order the items so
each one ends in a state you can verify. Under each item, give a command or
observation under **Verify** and an expected result under **Expected**.
Verify the result before you proceed to the next item.

The analyzer checks the documented headings, contract fields, and basic
Mermaid structure. Review the diagrams and the meaning of each field before
approval.

```markdown
## Plan

- [ ] Add a retry test for report creation.
  - **Verify** Run the report integration test and count the saved reports.
  - **Expected** Both attempts return the same report ID. One report exists.
```

## Self-check before GATE 1

- Name the boundary and justify each existing caller that must change.
- Explain how another variant can use the boundary and which order it needs.
- Show before-and-after code for each change. For additions and removals,
  show the side that exists.
- Record model compatibility, migration, and rollback.
- Record each breaking interface change and cite its consumer count.
- Record who enforces each changed invariant and where input is validated.
- If a write can retry, stop partway, or overlap, show its observable outcome.
- Make sure that the folder tree and workflow diagrams match the design.
- Give every plan item a verification step and an expected result.
