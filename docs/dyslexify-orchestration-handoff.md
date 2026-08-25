# Dyslexify orchestration handoff

Status: handoff only; no Symphony implementation is authorized by this document  
Recorded: 2026-08-25  
Source pilot: `reinispilens/dyslexify`

## Purpose

The Dyslexify Chrome MVP pilot exposed several responsibilities around a product change that are
generic orchestration concerns. This note records those concerns for later Symphony planning while
keeping the current implementation boundary explicit:

```text
Symphony                     repository                     workspace control plane
authorize and coordinate -> define and prove correctness -> provide trusted CI capacity
```

The Dyslexify build must not grow ad hoc Symphony features. Conversely, Symphony must not learn
Dyslexify concepts such as DOM ownership records, source-character invariants, or package-specific
test selection.

## Current ownership that should remain

These capabilities already belong to Symphony and should remain generic:

1. Poll the configured tracker, normalize eligible items, and treat configured active states plus
   route labels as the authorization boundary.
2. Claim work once, enforce global and per-state concurrency, reconcile status changes, cancel
   ineligible work, and retry transient orchestration failures.
3. Allocate the workspace path and invoke the repository's lifecycle hooks. Refusal or incomplete
   cleanup must retain the workspace and surface an error; Symphony must never bypass a guarded
   repository teardown.
4. Carry issue identity, attempt identity, state generation, and managed workpad operations across
   an agent run without exposing tracker credentials to the child process.
5. Emit generic lifecycle and retry observations. Product meaning remains in repository evidence.

The existing split inside workspace setup is intentional. Symphony allocates and coordinates the
workspace, while the repository hook selects the Git base SHA, creates the branch/worktree, claims
repository resources, installs dependencies, and removes them safely. Symphony's fresh-attempt
receipt and the repository's resource receipt solve different problems and must not be collapsed.

## Future Symphony candidates surfaced by the pilot

The following are handoff items, not work for the Dyslexify implementation session.

### 1. Durable delivery-phase coordination

After an agent opens a pull request, Symphony currently lacks a first-class, durable model of the
delivery phase. A future design may correlate the authorized item, attempt, workspace, branch, pull
request, immutable head SHA, required-check run, merge result, and terminal cleanup. It should be
able to wait without consuming agent turns and resume after daemon restart.

The repository must still declare which checks are authoritative and what their outcomes mean.
Candidate-controlled code must not be allowed to weaken the required proof or select a smaller
proof after inspection.

### 2. CI outcome classification and retry policy

The pilot confirmed that a red CI run can be caused by candidate code, a repository proof defect,
provider service, or runner construction occurring elsewhere. Symphony may eventually own the
generic state machine that distinguishes those classes and decides whether to wait, retry, resume
the agent, or hand work to a human.

This must consume trusted provider and repository signals; it must not infer success from a green
summary or treat every red run as a product defect. A retry must remain bound to the same immutable
head SHA. Repository verdicts such as `passed`, `failed`, `setup_refused`, and `non_verdict` must be
preserved as named outcomes rather than collapsed to booleans.

### 3. External-state waiting and restart recovery

Long waits for GitHub checks, merge queues, reviewer actions, or temporarily unavailable runners
should be represented as durable orchestration state instead of a sleeping Codex turn. A future
design needs bounded polling or event ingestion, cancellation, timeout policy, and restart recovery
without creating a second claim or losing the current attempt identity.

### 4. Cross-system attempt correlation

Logs and operator views should make one attempt traceable across the board item, Symphony worker,
workspace receipt, repository branch, pull request, commit SHA, CI workflow/run, merge commit, and
cleanup result. Symphony should own generic correlation identifiers. Repository- and
provider-specific adapters should supply their native identifiers without transferring authority
to candidate code.

### 5. Runner-availability consumption, not runner construction

Symphony may consume a trusted availability or incident signal from the workspace control plane so
it can avoid misclassifying runner outages and can defer dispatch safely. Building runner images,
managing runner fleets, protecting CI planners/executors, and operating credentials belong to the
workspace control plane, not Symphony.

### 6. Explicit executor routing diagnostics

The pilot used direct-agent work while a separate Symphony path was being prepared. Symphony
already evaluates configured required and excluded labels; a future operator-facing diagnostic
could explain why an otherwise active board item is or is not routable. It must remain read-only
with respect to repository policy and must not invent missing labels or active lanes.

## Items that do not belong in Symphony

| Item surfaced during the Dyslexify pilot | Durable owner | Reason |
| --- | --- | --- |
| DOM records, rendering, extension behavior, and source-preservation invariants | Dyslexify | Product truth |
| Domain tests, mutation controls, proof selection, and statements of what proof does not establish | Dyslexify | The repository defines correctness |
| GitHub Actions workflow and repository-required check names | Dyslexify, using protected shared CI contracts where adopted | Repository admission policy |
| Targeted-CI planner/executor protection and disposable runner fleet | Workspace control plane | Trusted execution infrastructure |
| Worktree base-SHA selection, branch naming, dependency receipt, and guarded cleanup implementation | Repository harness; reusable shape in the onboarding template | Repository resources and Git policy |
| Task-to-issue publishing and provenance refresh | Onboarding/publisher skill and template | Repository bootstrap tooling, not runtime scheduling |
| Package-layout and throughput checker repairs | Dyslexify | Repository-specific proof behavior |
| Interpreting `SourceNodeRecord`, `AnnotatedBlock`, G1-G4, or any task identifier | Dyslexify | Domain and plan semantics |

Three observed incidents reinforce this boundary:

- A provider-throughput control was flaky because of how the repository checker measured planted
  defects. The repair belonged in Dyslexify, not Symphony.
- A manually installed dependency bypassed the repository `before-run` receipt. Guarded teardown
  correctly refused to delete unowned artifacts; no Symphony cleanup bypass should be added.
- Published task issue provenance drifted after the source task file moved. That belongs in the
  task publisher/onboarding system, not in Symphony's tracker runtime.

## Suggested planning order

If these candidates are authorized later, plan them in this order:

1. Define an authority-safe delivery/CI observation contract and immutable attempt identity.
2. Define the outcome taxonomy and trusted source for provider versus candidate failures.
3. Add durable wait/restart behavior around that contract.
4. Add cross-system observability and routing explanations.
5. Integrate only a read-only runner-availability signal from the workspace control plane.

No item above is required to continue the Dyslexify MVP through its repository-owned direct lane.
The pilot can continue producing product code and proof while Symphony work is separately planned,
authorized, and reviewed.
