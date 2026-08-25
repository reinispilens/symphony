# Dyslexify orchestration handoff

- Status: accepted pilot boundary; runtime implementation must land centrally before product
  migration
- Recorded: 2026-08-25
- Source pilot: `reinispilens/dyslexify`
- Boundary decision: [`repository-driver-boundary.md`](repository-driver-boundary.md)

## Purpose

The Dyslexify Chrome MVP pilot exposed missing Symphony capabilities around repository setup,
attempt recovery, CI, and delivery. This note transfers those findings into Symphony without
turning Dyslexify into a second orchestration implementation.

```text
Dyslexify                         Symphony                         workspace control plane

product truth ─┐
tests          ├─▶ thin facts/policy adapter ──▶ lifecycle and recovery ──▶ trusted CI capacity
check policy   ┘                                  delivery coordination      and credentials
```

The boundary is central-first: Symphony implements reusable features here, WCP proves candidate
source through protected authority, and only then asks Dyslexify for thin declarations. Dyslexify
must not grow branch creation, worktree
ownership, dependency receipts, retry state, cleanup orchestration, CI waiting, or delivery
coordination merely so Symphony can run.

## Boundary correction from the pilot

The current Symphony compatibility path invokes repository-owned lifecycle hooks. The pilot used
that path and therefore made it tempting to treat its division of work as the permanent
architecture. That conclusion is incorrect.

The pilot did not reveal a need for a better Dyslexify harness. At plan approval it revealed that
Symphony lacked a first-class repository driver. Base-ref resolution, immutable SHA pinning,
branch/worktree creation, preparation state, ownership leases, guarded reset, and terminal cleanup
are one generic lifecycle. Splitting that lifecycle between Symphony and scripts copied into every
target repository weakens recovery and duplicates privileged code. The central state/driver/pnpm
foundation now exists in Symphony; Dyslexify still waits for its accepted contract plus protected
proof and delivery.

Current hook-based behavior remains an operational fact until it is migrated. It is not a template
for new target repositories and must not be extended with additional Symphony features.

## Ownership that remains in Dyslexify

Dyslexify continues to own product truth:

- DOM records, rendering behavior, extension behavior, and source-preservation invariants.
- Domain tests, mutation controls, package-layout checks, and throughput checks.
- Product build and proof entry points, including what each proof does and does not establish.
- Repository admission policy, including the names of authoritative required checks.
- Package manifests, lockfiles, and other declarations consumed by a preparation driver.
- Any Dyslexify-specific vocabulary such as `SourceNodeRecord`, `AnnotatedBlock`, G1-G4, or task
  identifiers.

These are not Symphony features. Symphony may invoke or observe them, but it must not interpret
their product meaning.

## Symphony capabilities surfaced by the pilot

The following capabilities belong in Symphony. None should be implemented in Dyslexify first.

### 1. Symphony-owned repository and workspace lifecycle

Symphony needs one `WorkSession` aggregate and state store plus a first-class repository driver that
consumes trusted repository facts and owns the complete stateful lifecycle:

- Validate repository identity and allowed base policy.
- Resolve and pin one immutable base SHA for the complete WorkSession, including later Attempts.
- Generate a collision-safe branch name.
- Create, verify, reuse, reset, and remove the Git worktree.
- Run the selected dependency-preparation capability.
- Persist fenced workspace leases and external-effect intents outside the candidate workspace.
- Recover idempotently after restart and refuse cleanup when ownership is ambiguous.

The Dyslexify profile may declare an allowed base ref, authoring-context routes, and a portable
preparation class. The operator-owned Symphony binding—not Dyslexify—selects branch namespace and
host topology. Dyslexify must not implement these operations.

### 2. Durable delivery-phase coordination

After the agent stops editing, Symphony needs a trusted source-materialization and delivery saga
beneath the same WorkSession. The managed agent intentionally has neither Git-ref nor delivery
credentials. Symphony must verify the workspace lease, turn the exact working tree into a recorded
immutable tree/commit without candidate hooks or filters, atomically advance only the managed
branch, then correlate the origin, attempt, workspace, pull request, immutable head SHA,
required-check run, merge result, and terminal cleanup. It must be able to resume after daemon
restart without consuming agent turns.

Dyslexify still declares product claims, domain risks, and what its outcomes mean. WCP's protected
base policy and exact base/head diff determine the minimum proof; candidate changes may widen but
cannot reduce it. Symphony owns waiting, correlation, transitions, and recovery.

### 3. CI outcome classification and retry policy

A red CI run can be caused by candidate code, a repository proof defect, a provider service, or
runner construction elsewhere. Symphony should own the generic state machine that distinguishes
trusted outcome classes and decides whether to wait, retry the same immutable head, resume the
agent, or hand work to a human.

Repository verdicts such as `passed`, `failed`, `setup_refused`, and `non_verdict` must remain named
outcomes rather than being collapsed to booleans. Dyslexify supplies the repository-specific
meaning; Symphony owns the orchestration response.

### 4. External-state waiting and restart recovery

Long waits for GitHub checks, merge queues, reviewer actions, or temporarily unavailable runners
must be durable orchestration state rather than sleeping Codex turns. Symphony needs bounded
polling or event ingestion, cancellation, timeout policy, and restart recovery without creating a
second claim or losing attempt identity.

### 5. Cross-system attempt correlation

One WorkSession and child attempt must be traceable across the board item, Symphony worker, workspace lease,
repository branch, pull request, commit SHA, CI workflow/run, merge commit, and cleanup result.
Symphony owns the generic correlation identity. Thin provider adapters supply native identifiers
without transferring transition authority to candidate code.

### 6. Runner-availability consumption

Symphony may consume a trusted availability or incident signal from the workspace control plane so
it can defer dispatch and avoid misclassifying runner outages. Building runner images, managing
runner fleets, protecting CI planners/executors, and operating credentials remain control-plane
responsibilities.

### 7. Executor-routing diagnostics

Symphony already evaluates configured required and excluded labels. An operator-facing diagnostic
may explain why an otherwise active board item is or is not routable. It remains read-only with
respect to repository policy and must not invent missing labels or active lanes.

## Thin Dyslexify adapter

The eventual Dyslexify integration contains only portable facts and product context required by the
Symphony driver. Its implemented profile shape is:

```json
{
  "schemaVersion": 1,
  "repositoryIdentity": "reinispilens/dyslexify",
  "baseRef": "refs/remotes/origin/main",
  "authoringContext": {
    "promptPath": ".symphony/prompt.md",
    "paths": ["AGENTS.md"]
  },
  "preparationClass": "pnpm"
}
```

This is an implemented Symphony schema, not authorization to edit Dyslexify yet. A separate
operator binding outside Dyslexify pins this profile by exact Git revision/digest and supplies the
exact trusted Git executable plus the
source checkout, disjoint state/workspace roots, branch namespace, tracker, capacity, timeouts, and
exact Codex/systemd executables. Neither machine-specific paths nor operational authority are
committed as Dyslexify facts. Required checks and product-proof meaning remain in the later
WCP/delivery seam, not this repository-lifecycle profile.

## Responsibilities that remain elsewhere

| Pilot concern                                                       | Durable owner                | Why                                                  |
| ------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| DOM records, rendering, extension behavior, and source preservation | Dyslexify                    | Product truth                                        |
| Domain tests, mutation controls, and proof definitions              | Dyslexify                    | The repository defines correctness                   |
| Product claims, risks, tests, and candidate workflow additions      | Dyslexify                    | Product correctness and optional proof widening      |
| Protected planner/admission/executor/parser/gate and runner fleet   | Workspace control plane      | Candidate-independent proof authority                |
| Task-to-issue publishing and provenance refresh                     | Onboarding/publisher tooling | Repository bootstrap tooling, not runtime scheduling |
| Package-layout and throughput checker repairs                       | Dyslexify                    | Repository-specific proof behavior                   |
| Interpreting Dyslexify types, gates, or task identifiers            | Dyslexify                    | Domain and plan semantics                            |

Worktree creation, base-SHA resolution, branch naming, Symphony receipts, fresh-attempt recovery,
and guarded cleanup are intentionally absent from this table. They are Symphony responsibilities
under the accepted repository-driver boundary.

## What the observed incidents teach us

Three incidents from the pilot reinforce the corrected boundary:

- A provider-throughput control was flaky because of how a Dyslexify checker measured planted
  defects. The checker repair belongs in Dyslexify because it expresses product proof.
- A manually installed dependency bypassed a repository `before-run` receipt. This shows why
  preparation ownership and durable lifecycle evidence should move into Symphony; it does not
  justify copying a stronger receipt implementation into Dyslexify.
- Published task provenance drifted after a source task file moved. That remains a publisher and
  onboarding concern, not Symphony runtime scheduling.

## Planning and migration order

Work should proceed from the central boundary outward:

1. Freeze new repository harness work and establish one WorkSession model and transactional
   SymphonyStateStore with tracker origin first.
2. Introduce the RepositoryDriver, accepted profile/binding resolver, guarded Git worktrees, and
   exact Codex sandbox/descendant-scope policy in Symphony. Require cgroup quiescence before runtime
   lease release so Dyslexify cannot widen or bypass it through repository configuration.
3. Add offline-only sandboxed pnpm preparation: operator-pinned toolchain/policy, read-only seed,
   attempt-private index/cache, strict source/integrity/config admission, no host/private/metadata
   network, and no tracker, delivery, WCP, home, sibling, state, or host-control credentials/paths.
4. Build WCP proof v2: protected base/diff planning, admission, isolated execution, protected
   parsing/gating, independent full regression, and four-way product outcomes.
5. Run a capacity-one canary and prove cleanup before using WCP for this pilot.
6. Add durable delivery as a fenced WorkSession saga in Symphony.
7. Rewrite `.github` onboarding and thin the template only after the central contracts exist.
8. Define and install only the thin Dyslexify declarations in a separate Dyslexify change.
9. Prove crash recovery, fresh-attempt replacement, protected proof, delivery, and safe cleanup in
   the real pilot before removing compatibility code.

The Dyslexify direct lane may continue producing product code and product proof while Symphony is
built separately. It must not become the place where missing Symphony lifecycle features are
implemented. The integration point is added only after the central capability exists.
