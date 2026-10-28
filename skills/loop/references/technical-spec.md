# Technical spec structure

Read this at Stage 2, before writing the spec.

A spec made only of prose and a sequence diagram cannot be refined. Reviewers
can argue with it but not correct it, because nothing in it is a concrete
delta. These four sections make the design reviewable: each one states what
exists now, what it becomes, and what that breaks.

Order the spec as: Architecture decision, Data models, Interfaces, Folder
structure, Workflows.

## 1. Architecture decision

The decision is **what seam you add**, not which named pattern you adopt. A
pattern is only the shape a seam takes.

Your recorded convention is **additive integration**: extend through clean
seams — an interface, an injected function, a strategy or a decorator — without
modifying existing call sites. State how this change does that.

| | |
| --- | --- |
| Seam added | the interface, parameter or boundary introduced |
| Composes by | wrap, substitute, sequence or inject |
| Call sites touched | how many existing ones change, and why |
| Rejected | what else fitted, and the reason it lost |
| Fits because | the existing convention it matches, cited |
| Costs | what this makes harder later |

"Call sites touched: 0" is the goal, not a boast. If the number is not zero,
say what forced it — a signature change, a widened return, a new required
argument. That is the real cost of the design.

Ground the "fits because" row in the codebase, not in taste. Use
`graphify query "<question>"` for dependency facts and `lsp_navigation`
references for real call sites. A claim that the repo "already does it this
way" is checkable, and should be checked.

For a wider audit of an unfamiliar system, invoke
`/skill:documenting-system-architecture`.

### Compose, do not accumulate

Prefer a mechanism that lets the next change be additive too. Each row says
how units combine, not merely when the pattern applies.

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

The test of a composable unit:

- **Closed under composition.** Same shape in, same shape out, so two of them
  combine into a third of the same kind. A decorator that returns a different
  type than it wraps composes once and then stops.
- **Additive.** A second variant needs no edit to the first, and no edit to
  the caller.
- **Isolated.** Testable with no I/O and no global state, which is what makes
  the no-mock integration test at Stage 7 possible rather than painful.
- **Order-independent, or explicitly ordered.** If order matters, the spec
  says so and says why.

These anti-patterns destroy composability. Name one explicitly when you
reject it:

- a flag parameter selecting behaviour inside a function, instead of two
  composable units
- hidden global or package-level state, which makes two instances interfere
- an interface with many methods, so every implementation carries weight it
  does not use
- inheritance or embedding used for reuse, which fixes behaviour at compile
  time instead of at composition time
- a new abstraction with one implementation and no second planned
- an event used where a function call would do, for "decoupling"

## 2. Data models

Only entities this change touches.

| Entity | Change | Fields | Compatibility |
| --- | --- | --- | --- |
| `Tunnel` | modified | `+authzMode string` | additive, default `legacy` |
| `GrantRecord` | new | `id`, `subject`, `scope` | new table, no backfill |
| `LegacyAcl` | removed | — | read path kept one release |

Rules:

- Name the real type or table, not a description of it.
- Mark each change `new`, `modified`, or `removed`.
- State the compatibility consequence. "Additive" and "breaking" are
  different conversations.
- Say whether a migration is needed, and whether it is reversible.

## 3. Interfaces

Every signature a caller can see: HTTP routes, exported functions, gRPC
methods, CLI flags, published events.

| Interface | Before | After | Breaking | Consumers |
| --- | --- | --- | --- | --- |
| `GET /v1/tunnels/{id}` | `acl` | `authz` | yes | 2 (UI, CLI) |
| `ResolveTarget(opts)` | `(string)` | `(string, error)` | yes | 7 sites |
| `tunnel.granted` | — | new event | no | none yet |

Get the consumer count from the tools, not from memory: `lsp_navigation`
references for code, `graphify query` for cross-module reach. A breaking
change with an unknown blast radius is not specified yet.

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

Mermaid `sequenceDiagram` blocks, which render in the GitHub issue body.
Cover the happy path plus the failure and edge flows that the data model or
interface changes above actually introduce.

## Self-check before GATE 1

- Is the seam named, and the call-site count stated — zero, or justified?
- Is the unit closed under composition, so two of them make a third?
- Could a second variant be added without editing the first or the caller?
- Does every interface row have a consumer count from a tool?
- Does the folder tree match the seam named in section 1?
- Does each data-model row say whether it is breaking?
- Could a reviewer rewrite a row to disagree with you? If not, it is prose.
