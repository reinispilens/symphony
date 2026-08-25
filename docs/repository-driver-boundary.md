# Symphony-owned repository driver boundary

- Status: accepted architecture; slices 2–5 implemented, later estate slices pending
- Recorded: 2026-08-25
- Decision owner: Symphony

## The system in one picture

```text
target repository                 Symphony                         control plane / providers

product code and tests      ─┐
repository facts and policy ─┼─▶ repository driver ──▶ durable orchestration ──▶ trusted tools
thin adapter                ─┘       │                       │                    and capacity
                                   Git/worktrees           WorkSessions
                                   preparation             waits
                                   safe cleanup            recovery
```

The governing rule is:

> A repository provides facts and product policy. Symphony provides the machinery that acts on
> those facts, owns lifecycle state, and recovers that work.

A target repository must not implement a feature merely to make Symphony run. If onboarding a
second repository requires copying branch, worktree, receipt, retry, or cleanup code from the first
repository, Symphony has placed its boundary incorrectly.

## Context

The Node implementation retains a `workspace.provider: harness` compatibility path. In that path,
Symphony allocates a directory and invokes repository-owned shell hooks, while the target
repository may select a base SHA, create a branch and worktree, prepare dependencies, record
repository receipts, and remove the workspace. This works operationally, but it distributes a
single orchestration feature across every target repository.

That distribution creates four problems. Lifecycle behavior can drift between repositories,
restart recovery depends on repository-specific code, privileged cleanup logic is repeatedly
reimplemented, and a repository cannot adopt Symphony through a genuinely thin integration. The
current harness path is therefore transitional compatibility behavior, not the desired ownership
model.

This decision preserves an important distinction: centralizing Symphony machinery does not move
product truth into Symphony. Product behavior, tests, package manifests, and admission policy stay
with the product repository. Symphony learns only the generic facts required to coordinate them.

## Decision

Symphony will own a first-class repository driver and its lifecycle state. A repository integration
will be a thin, trusted adapter that supplies repository-specific facts and selects capabilities
implemented by Symphony. One transactional `SymphonyStateStore`, with `WorkSession` as its aggregate
root, owns the driver's intent, lease, fencing generation, and outcome.

The initial adapter should be declarative. An executable adapter may be introduced only when a
provider genuinely requires translation code, and then it must remain a narrow edge adapter behind
a Symphony-owned state machine. It must not decide attempt transitions, implement retries, own
receipts, or perform unbounded lifecycle orchestration.

### Ownership by concern

| Concern                    | Target repository or thin adapter                                          | Symphony                                                                                             | Workspace control plane or provider                                       |
| -------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Product behavior           | Owns code, domain invariants, and domain tests                             | Does not interpret product semantics                                                                 | Provides execution capacity only                                          |
| Repository identity        | Declares its canonical identity and allowed base ref                       | Derives the tracker hostname, validates the full origin, resolves the ref, and pins an immutable SHA | Hosts or exposes the source repository                                    |
| Host binding               | Contains no machine-specific source, state, or workspace paths             | Binds identity to disjoint operator-controlled source, state, and workspace roots                    | Provides the host filesystem or remote execution target                   |
| Branch and worktree policy | Contains no host branch namespace or worktree path                         | Binding selects namespace; driver generates, verifies, resets, and removes worktrees                 | Exposes Git credentials where required                                    |
| Dependency preparation     | Owns manifests, lockfiles, and named product build entry points            | Selects and runs a built-in preparation driver; records outcome and retry state                      | Supplies caches or isolated execution capacity                            |
| Product proof              | Owns tests, claims, domain risks, and statements of what proof establishes | Requests and correlates exact source-bound proof                                                     | Protects planning/admission/execution/parsing/gating and returns outcomes |
| Resource requirements      | Declares required resource classes or native identifiers                   | Coordinates leases, correlates them to the attempt, and releases them safely                         | Constructs and operates the resources                                     |
| Sessions and attempts      | Supplies no mutable orchestration state                                    | Owns WorkSession inputs, decisions, attachments, attempts, generations, leases, sagas, and recovery  | May supply provider-native event and run identifiers                      |
| Cleanup                    | Supplies only repository-specific facts needed to prove ownership          | Verifies ownership and performs or coordinates idempotent cleanup                                    | Removes externally managed resources when requested through a trusted API |
| Credentials                | Must not expose credentials through candidate code                         | Keeps credentials outside the coding-agent environment                                               | Issues and protects credentials and runner identity                       |

The subtle but important line is between policy and mechanism. A repository may declare
`refs/remotes/origin/main` as an allowed base. Symphony resolves that ref to a SHA and records it. A repository
may declare that `test` and `build` are required checks. Symphony waits for those checks and decides
whether to resume, retry, or hand off. A repository may contain a `pnpm-lock.yaml`; Symphony owns
the preparation lifecycle that consumes it.

## Thin-adapter contract

A thin repository adapter may provide:

- Stable repository identity.
- The allowed base ref and authoring-context routes.
- A portable preparation class implemented by Symphony.
- Product-owned claims, risk classes, build/test entry points, and verdict meanings.
- Required external resource classes and provider-native identifiers.
- Product instructions and prompt context that do not grant orchestration authority.

A thin repository adapter must not:

- Resolve or persist the immutable base SHA.
- Generate branches or create, reset, verify, or delete worktrees.
- Implement dependency receipts, attempt generations, retries, waits, or recovery.
- Claim or release shared resources through a repository-owned state machine.
- Poll CI, classify retryability, coordinate pull requests, or decide terminal cleanup.
- Store Symphony credentials or expose them to candidate-controlled processes.
- Select, reduce, parse, or publish its own protected proof verdict.
- Use candidate-controlled files to prove that candidate code is safe to run or delete.

Shell hooks remain part of the base specification and can remain available as explicit extension
points. They must not be the implementation of a required Symphony capability. In particular, the
new repository driver must not depend on a target repository's `prepare-workspace` or
`remove-workspace` script for its Git ownership, durable receipts, or safe teardown.

## Authority and durable state

Symphony resolves the trusted repository profile and every named authoring-context file from the
exact Git revision/digest selected by an operator deployment binding, then pins those identities and
digests to the WorkSession. Machine-specific source/state/workspace paths, branch namespace,
tracker, capacity, timeouts, and runtime executables live only in that binding outside the product
repository. Candidate code may change product files, but it cannot change the base SHA, cleanup
authority, host topology, runtime policy, or driver selection for its own Attempt.

Every managed workspace needs a fenced Symphony-owned lease inside the one state store, outside the
candidate workspace. The aggregate is:

```text
WorkSession
├── origin: tracker | interactive
├── doctrine + accepted product/context/binding snapshots
├── revisioned plan + decisions
├── controller assignment generation
├── 0..1 human attachment (session-level; never a lease)
├── 0..n Attempts
│   ├── 0..1 runtime lease
│   └── 0..1 managed or compatibility workspace lease
└── materialization + proof + delivery state
```

The human attachment is intentionally outside the Attempt subtree. It records where a human is
working but grants no RepositoryDriver cleanup or materialization authority. Those APIs accept
only the managed/compatibility workspace-lease union, making accidental adoption of a human
checkout a type error rather than a convention.

At minimum, the workspace lease must bind:

- The WorkSession and Attempt identities plus current fencing generation.
- The repository identity and trusted profile digest.
- The canonical source root and workspace root.
- The immutable base SHA and generated branch name.
- The workspace path, selected driver, driver version, and lifecycle phase.
- Any external resource lease identifiers.

Cleanup authority comes from this lease plus independent verification of the filesystem and Git
metadata. The presence of a directory or a repository-produced receipt is not sufficient proof of
ownership. When ownership cannot be proven, Symphony retains the resource, reports the exact
refusal, and waits for operator repair.

## Intended lifecycle

```text
authorized tracker item or explicit interactive origin
      │
      ▼
create/recover WorkSession + snapshot trusted profile
      │
      ▼
lease allocating ──▶ create worktree ──▶ prepare unprivileged ──▶ lease ready
      │                       │                       │
      └──────── recover or retain on restart/failure ┘
                                                      │
                                                      ▼
                                run coding agent in descendant scope
                                                      │
                                                      ▼
                                      prove descendant scope empty
                                                      │
                                                      ▼
                                      observe proof and delivery state
                                                      │
                                                      ▼
                                      verified cleanup ──▶ record removed
```

Each transition must be idempotent and fenced. Before an external effect, Symphony transactionally
records an intent and idempotency key; after the call, it records observed external truth. It never
holds a state transaction open across Git, Codex, GitHub, or WCP. After a process crash, Symphony
reads its own state, inspects
the external state, and either completes the interrupted transition or refuses safely. It does not
ask candidate code to reconstruct authority.

## Local implementation checkpoint

The implementation introduced with this change contains the WorkSession/SQLite store,
RepositoryDriver routing, managed Git-worktree driver, strict profile/binding resolver, exact Git
process policy, managed Codex launch/sandbox/systemd scope, and sandboxed pnpm preparation described
by Slices 2–5.
Deterministic tests include cross-process fencing, real-Git create/reuse/replacement and crash
recovery, dirty/ambiguous cleanup refusal, exact Git/runtime resolution, ambient Git-authority
scrubbing, hook suppression, executable-filter refusal,
quiescence-before-lease-release, runtime-private temp cleanup, real frozen pnpm execution with
lifecycle scripts and hooks suppressed, SHA-512/custom-source admission, an operator-pinned
read-only seed with Attempt-private index/cache, host/private/metadata network denial,
host/state/sibling/secret non-observation, preparation timeout/cancellation descendant teardown,
and an accepted-binding no-hook daemon journey. An opt-in host probe separately proves a detached
authoring descendant is removed through the user scope after its parent exits.

That evidence establishes the Symphony foundation but does not close the decision estate-wide. WCP
protected proof, durable delivery, doctrine publication, and the Dyslexify pilot remain Slices 6–8.

## Migration plan

The migration should land in narrow slices so orchestration behavior remains testable throughout.

### Slice 1: record and enforce the boundary in planning

- Publish this decision and correct the Dyslexify handoff.
- Mark the current harness integration as transitional in operator-facing documentation.
- Stop creating new repository-owned workspace harnesses.
- Keep accepted/merged capability distinct from local candidate implementation evidence.

### Slice 2: establish one durable WorkSession store

- Add `WorkSession` with `tracker | interactive` origin; implement tracker origin first.
- Add one transactional SQLite `SymphonyStateStore` for sessions, attempts, controller assignments,
  runtime/workspace leases, proof correlation, delivery state, and external-effect intents.
- Persist fencing generations and reject stale writes or external effects.
- Adapt the existing tracker flow before adding a manual surface.

### Slice 3: introduce the internal repository-driver port

- Separate orchestration-facing workspace operations from the current hook implementation.
- Place current `directory` behavior behind one driver.
- Place the existing harness path behind an explicitly named legacy driver for migration only.
- Preserve scheduler, tracker, and agent-runner behavior while changing the internal composition
  boundary.

### Slice 4: implement the Symphony-owned Git worktree driver

- Resolve an allowed base ref from a trusted source repository once, then keep its immutable SHA
  pinned across every Attempt in the WorkSession.
- Generate a deterministic, collision-safe branch name in an allowed namespace.
- Create the worktree without first relying on code inside that worktree.
- Store a fenced Symphony-owned workspace lease and verify it before reuse or removal.
- Make provisioning, fresh-attempt replacement, terminal cleanup, and crash recovery idempotent.
- Refuse ambiguous ownership instead of falling back to recursive deletion.
- Fix managed Codex approval, sandbox, and process-containment policy in Symphony; resolve exact
  executables outside source/state/workspace roots; deny network and ambient temp roots; and grant
  one Attempt-private temp root. Product configuration cannot weaken this boundary. Time expiry
  cannot replace the Attempt until the descendant scope is proven empty.

### Slice 5: add unprivileged preparation

- Begin with the toolchain required by the first pilot rather than a universal plugin framework.
- Keep manifests, lockfiles, tests, and proof definitions in the target repository.
- Keep execution state, preparation outcomes, retry policy, output classification, and correlation
  in Symphony.
- Run package preparation in a fail-closed restricted sandbox without tracker, delivery, WCP,
  deployment, home-directory, sibling-repository, or host-control credentials/paths; always disable
  lifecycle scripts/hooks, remove host networking, mount only an operator-pinned seed read-only,
  and use an attempt-owned cache/index. Authoring-runtime capability and protected-proof isolation
  remain their own explicit threat models.
- Bind the selected profile immutably to each attempt.

### Slice 6: establish protected proof before the pilot

- WCP computes the required floor from protected base policy and the exact base/head diff.
- WCP separates planner, admission, isolated executor, protected result parser, and final gate.
- Candidate policy may widen but cannot reduce proof; independent full regression remains.
- Run hostile no-op/config/result-channel tests and a capacity-one disposable-runner canary.

### Slice 7: add durable delivery orchestration

- Add delivery as a WorkSession saga bound to pull-request and immutable-head identity.
- Add external CI waiting, restart recovery, and four-way outcome classification.
- Add merge coordination, cross-system correlation, and terminal cleanup through idempotent effect
  intents.
- Keep delivery credentials out of preparation and candidate runtime.

### Slice 8: prove the boundary with a fixture, then migrate a pilot

- Exercise the full lifecycle against temporary Git repositories owned by the Symphony test suite.
- Demonstrate that a new repository runs without any `scripts/harness` implementation.
- Test interruption after every stateful provisioning and cleanup step.
- Migrate Dyslexify only after the central driver passes these gates.
- Leave Dyslexify with product code, proof policy, and a thin adapter; remove duplicated Symphony
  machinery in a separately authorized repository change.

## Acceptance boundary

The migration is complete when all of the following are true:

1. A fixture repository can be onboarded using only a thin declarative profile and product-owned
   build/test definitions.
2. No target repository script creates or removes a Symphony worktree, writes a Symphony receipt,
   implements fresh-attempt recovery, or polls delivery state.
3. Symphony can recover provisioning and cleanup after restart from one WorkSession store without
   executing candidate code to
   rediscover authority.
4. Candidate changes cannot alter the base SHA, selected driver, protected proof floor, result
   parser, or cleanup target for their own attempt.
5. Workspace removal requires the matching controller generation and fenced Symphony lease, no
   active runtime lease, root-containment checks, and independent Git/filesystem verification.
6. Tracker-origin and interactive-origin work use the same WorkSession schema and store.
7. Targeted tests, `pnpm check`, and `pnpm build` pass before each implementation handoff.

This decision does not move domain logic, CI construction, or repository admission policy into
Symphony. It moves only Symphony's reusable execution and coordination machinery back behind the
Symphony boundary.
