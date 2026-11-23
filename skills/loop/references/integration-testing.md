# Integration verification principle

Apply this principle to every `/loop` feature. Verify behavior at the
production-facing boundary. Do not claim that a skipped or unavailable
required test passed.

## Baseline before implementation

Before changing the feature, run tests that cover the affected behavior.
Scale the baseline to the change's risk. Run the full suite if the project
requires it or the change can affect unrelated paths. Record the commands,
revision, results, and existing failures. If no suite exists, record that
fact. Add tests through the public interface for uncovered behavior.

If the behavior is new, record that no prior behavior exists. A baseline
shows current behavior. It does not make an existing defect the contract.

If a required test or dependency is unavailable, report `BLOCKED` or
`INCONCLUSIVE`. Stop before claiming that verification passed. Restore the
dependency and run the required test before proceeding.

## System and dependency boundaries

Run the current repository's implementation for real. Exercise its public
entrypoint and transport. If a service or CLI's process boundary matters,
use a real process. For a library, use its public interface.

Run collaborators inside the current repository for real. Treat a different
repository as external, even when the same team owns it. For external
systems, prefer a contract-backed wire-level double, such as WireMock or a
protocol-appropriate server. Verify its behavior against the available
provider contract, protocol specification, SDK types, or verified traffic.
Record any contract-fidelity gap. A local stub does not prove that a live
provider behaves the same way.

If an external system needs a stub and a wire-level double is not feasible,
use another kind of stub. Record why. Do not stub the current repository's
implementation or its in-repository collaborators.

## Test observable behavior

Run the test through the public interface. Derive the expected result from
the requirement. Assert the output, error, stored state, or external effect
that a caller can observe. Check request content or order if the contract
requires it.

Ask two questions about each assertion.

1. If the promised behavior breaks, does the test fail?
2. If a refactor preserves the promised behavior, does the test still pass?

If a command promises safe retries, run it twice and count the records it
created. The test must catch a duplicate. If a helper sends data to another
system, assert what that system receives.

Adapted from [Test Behavior, Not Implementation](https://github.com/cursor/plugins/blob/0b46ec399d55f2829e88822998f53b84944837d3/pstack/skills/principle-test-behavior-not-implementation/SKILL.md).

## Scenarios and fault testing

Write Given/When/Then scenarios in the project's test language. Verify the
contract shape and the behavior the scenario describes.

For each changed integration boundary, test relevant failure behavior.
Use controlled faults such as dropped connections, delays, or error replies.
A fault proxy, such as Toxiproxy, is one way to inject them. Verify that the
test reaches the fault and observes the intended result.
If fault injection does not apply, record the reason.

If a write can stop partway, run it again from that partial state. If two
attempts can overlap, test them together. Assert the final state, the results
returned to callers, and the number of external effects.

Keep the harness repeatable. Start the dependencies that the test needs,
wait for readiness, isolate test data, and clean up after each scenario.
If the harness uses test images or versions, pin them. Do not send test
traffic or test telemetry to production services.

## Diagnose repeated failures

If two fixes rely on the same assumption and both fail the same check, state
the assumption. Find an observation that would disprove it. Test it directly
and record the result before you choose the next fix.

## Completion evidence

Run the required integration tests locally. If the project has CI, configure
it to run the required integration tests. Verify the integration result for
the PR head before calling the ship gate clear. If the project genuinely has
no CI, recorded local results are sufficient. Do not treat a missing or
skipped required test as a pass. Pass each required integration job to
`loop ship-gate --required-check <name>`.

Report the baseline and post-change commands, revision, and outcomes. Record
passing tests and independent review for the final commit. Run the tests and
review again when fixes affect their evidence. Name any unverified provider
behavior. A test with a wire-level double verifies the local integration path.
[Evidence format](operations.md#record-evidence)
