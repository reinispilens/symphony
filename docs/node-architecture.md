# Node Symphony architecture

Status: durable managed-workspace and delivery substrate implemented; governance composition and
consumer pilot pending, 2026-08-26

> [!IMPORTANT]
> This document describes the managed Node implementation introduced with this change. The
> [`repository-driver boundary`](repository-driver-boundary.md), durable state store, and pnpm
> preparation driver, trusted materializer, and delivery coordinator are implemented here.
> Repository-owned hooks remain a transitional compatibility path only. Accepted governance
> composition and a product pilot remain later estate phases.

## The system in one picture

```text
product profile/context @ SHA       operator deployment binding
                  └──────────┬──────────┘
                             ▼
Pinned Workflow Source ──▶ Orchestrator ──▶ SymphonyStateStore (SQLite)
                                │                 attempts · leases · retries · outbox
                                ├── RepositoryDriver ──▶ managed Git worktree
                                ├── PreparationDriver ─▶ offline pnpm + read-only seed
                                ├── Agent Runner ──────▶ systemd scope ─▶ Codex + descendants
                                ├── Materializer ──────▶ private Git index ─▶ immutable commit
                                ├── Delivery saga ─────▶ trusted provider ─▶ Git host / WCP check
                                └── Tracker Adapter ───▶ GitHub Projects through `gh`

One process owns one binding, one repository, and one board; durable fencing prevents a second
process from acquiring the same active WorkSession attempt. Managed host composition validates the
accepted profile revision, source/origin/base, exact Git/runtime executables, and disjoint
source/state/workspace roots before state or workspace effects. Only a profile selecting `pnpm`
requires and validates preparation executables, an offline dependency policy, and a disjoint seed;
a `none` profile carries no dormant pnpm authority.
```

Symphony owns coordination and generic authoring mechanics: it observes authorized board work,
creates or recovers one durable WorkSession, fences an attempt, provisions a managed worktree,
prepares dependencies, runs Codex, reconciles tracker state, and persists retries and external
effect intents. Product resources and proof meaning remain repository-defined. The GitHub Projects
adapter owns provider-specific facts such as board membership and `dispatchable`; the generic
orchestrator never inspects a GitHub payload.

The Elixir tree is a reference implementation only. The Node implementation is built from
`SPEC.md`; it does not import, wrap, or mechanically port Elixir modules.

## Architectural boundaries

| Boundary             | Owns                                                                                           | Must not own                                    |
| -------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `deployment`         | strict product-profile and operator-binding schemas, exact-revision context resolution/digests | product proof meaning, workspace effects        |
| `workflow`           | compatibility YAML loading/reload, typed defaults, strict prompt rendering                     | managed host authority, tracker payloads        |
| `state`              | WorkSessions, pinned inputs, plans/decisions, attachments, attempts, leases, sagas, integrity  | tracker or Git truth, product semantics         |
| `tracker`            | required reads, normalization, provider errors, provider-native agent tools                    | scheduling, workspaces, generic retries         |
| `orchestrator`       | eligibility, durable claim/attempt transitions, reconciliation, timers as wake-up projections  | provider payload inspection, repository policy  |
| `repository`         | workspace port, Git-worktree implementation, ownership checks, guarded cleanup, legacy routing | dependency install, product proof               |
| `preparation`        | package input admission, offline pnpm sandbox, private caches/index, policy-bound outcomes     | worktree ownership, product build/proof meaning |
| `agent`              | Codex framing, managed launch/sandbox/cgroup, quiescence, private temp, scrubbed child env     | tracker credentials, board policy               |
| `observability`      | structured logs and snapshots projected from durable/runtime state                             | a second source of orchestration truth          |
| CLI composition root | select binding or compatibility workflow, open state, bind ports/daemon, own signals           | multi-repository routing or product policy      |

Dependencies point inward toward small contracts. The composition root binds one state-store,
tracker, repository-driver, preparation-driver, agent-runner, clock, and logger implementation.
Git and pnpm details stay at the edges. The orchestrator receives only the ports and fenced
authority records it needs, which keeps the state machine deterministic to test. These drivers do
not move product tests, required-check policy, or domain semantics into the scheduler.

## Runtime flows

### Startup

1. For managed Git, resolve `--binding`, validate its exact product profile revision/digest and
   context, compose a pinned workflow snapshot, and refuse positional `WORKFLOW.md` authority.
2. Validate source/origin/base, exact authoring and preparation executables, the offline seed and
   policy, and disjoint source/state/workspace/seed roots.
3. Open `<stateRoot>/state.sqlite`, validate or migrate it transactionally, and reconcile each
   expired lease only after its deterministic process scope is proven empty.
4. Build the selected tracker adapter and validate its provider and repository identities.
5. Sweep managed and compatibility workspaces for tracker items already in terminal states.
6. Schedule an immediate tick and register signal handlers. Only the compatibility source starts a
   last-known-good workflow watcher.

Managed startup validation fails loudly and the pinned binding never live-reloads. Compatibility
workflow edits retain their last-known-good behavior, but positional `git-worktree` admission is
refused.

### Poll tick

```text
reconcile running work
        ↓
reconcile expired leases through descendant quiescence
        ↓ proven                        unproven ──▶ retain lease; skip dispatch
check source preflight (compatibility only)
        ↓ valid                         invalid ──▶ skip new dispatch
select pinned/last-known-good workflow + adapter
        ↓
fetch active + terminal board items → normalize → remember terminal set
        ├── newly terminal + unclaimed ──▶ legacy repository-owned guarded cleanup
        └── active + eligible ───────────▶ claim and dispatch while slots remain
```

`running`, `claimed`, and timers are process-local projections used for efficient reconciliation;
WorkSessions, pinned inputs, plans/decisions, attachments, attempts, runtime/workspace leases,
retries, sagas, and outboxed effects are durable.
Starting an attempt is an immediate SQLite transaction, so two daemon processes cannot both acquire
one active runtime lease for the same WorkSession. An expired timestamp does not release that
lease; the orchestrator must first quiesce the matching WorkSession/controller process scope and
then commit the exact fenced expiry transition.
The state-list read requests active and terminal states together. An in-memory set remembers the
terminal IDs from the preceding successful read, so a card that was released in inactive Human
Review and later becomes terminal is cleaned without either a second board scan or a daemon
restart. A terminal item that is still claimed is left to its worker or retry lifecycle so cleanup
cannot race agent shutdown.

### Worker attempt

1. Create or recover the tracker-origin WorkSession, then acquire one fenced attempt/runtime lease.
2. Ask the selected RepositoryDriver to create or reuse the workspace. The managed driver records
   an allocating lease before `git worktree add`, then independently verifies Git identity before
   marking it ready. Legacy drivers preserve existing behavior.
3. For a fresh-attempt state, bind the worktree branch and replacement to the tracker generation;
   reuse the same generation and replace only a proven prior managed generation.
4. Run the selected preparation driver. Managed pnpm preparation records the manifest, lockfile,
   complete input-set, and dependency-policy digests. It rejects custom sources and pnpm hooks,
   snapshots the seed's SQLite index into an attempt-private cache, mounts package bytes read-only,
   and performs a frozen, script/hook-disabled offline install in a network-less Bubblewrap PID
   namespace. Termination covers the complete process tree before the result is recorded.
5. Render the strict prompt from the accepted context snapshot selected by the binding.
6. Resolve exact operator-owned runtime executables outside all governed roots, allocate one
   private state-root temp directory, and launch `codex app-server` in a deterministic systemd user
   scope with tracker credentials removed and environment expansion disabled.
7. Keep one app server alive across continuation turns, up to `agent.max_turns`.
8. Close the app server, signal and prove the entire cgroup empty, then remove private runtime
   state. A failed proof leaves the Attempt and runtime lease active for later reconciliation.
9. Persist the terminal Attempt outcome before scheduling a retry or another external effect; run
   legacy `after_run` only on the compatibility path.

Codex never starts when fresh provisioning is unproven. The driver first records the exact blocker
in the managed workpad and then moves the card to the configured inactive human lane. If that
tracker mutation fails, the retry queue repeats only the handoff; it does not run workspace setup or
Codex again.

### Recovery

The SQLite WorkSession store is the authority for accepted configuration/doctrine snapshots,
plans and decisions, human attachments, attempts, leases, retries, materialization/proof/delivery
state, and external-effect intents. A human attachment is a non-removable session-level reference,
not an Attempt workspace lease. Tracker and Git/filesystem reads remain authoritative for their own external facts and are
cross-checked during recovery; they never recreate missing Symphony ownership silently. Expired
runtime leases become candidates for process-scope quiescence and are marked interrupted only after
that proof; failed proof retains authority and blocks replacement. Durable retry due times continue
to gate normal-poll admission, pending effects are reconciled idempotently, and managed workspaces
are reused or retained according to their leases. A service session dying must not kill the detached daemon; daemon
supervision is an operational deployment layer, not multi-tenancy inside Symphony.

## Repository lifecycle decision

For new integrations, only an operator-owned binding selects the Symphony Git-worktree driver. The
product profile contains repository identity, a full allowed base ref, authoring-context routes,
and preparation class. The operator binding separately supplies the branch namespace and host
topology; the product cannot select them. Symphony derives the expected Git hostname from the
tracker profile instead of asking the product to duplicate it. The driver resolves the immutable
base SHA from the accepted source checkout, verifies
the complete `origin` host plus owner/repository identity, records
it as the WorkSession's managed-repository base before Git mutation, and reuses that SHA across
fresh Attempts even when the configured ref moves. It refuses cleanup unless the state lease plus
independent Git/filesystem observations all agree and the caller presents the matching controller
generation. Product repositories supply no lifecycle hooks in this mode.

The following hook behavior remains compatibility-only.

`SPEC.md` creates an empty directory and then runs `after_create` with that directory as `cwd`.
Therefore `pnpm harness:prepare` cannot be the first command: the empty directory has no
`package.json`. The current compatibility form is an explicit repository-owned entry point supplied
through the generic workflow-directory environment:

```yaml
hooks:
  after_create: node "$SYMPHONY_WORKFLOW_DIR/scripts/harness/prepare-workspace.mjs"
```

Symphony supplies non-secret lifecycle metadata as environment variables; it never interpolates an
issue title or description into shell source. The harness chooses the base SHA and branch name and
may run `git worktree add` into `$SYMPHONY_WORKSPACE_PATH`. Symphony's sanitized directory key is
not treated as a Git ref: allowed directory names include forms that Git rejects as branch names.

The core `workspace.provider: directory` lifecycle remains directory-owned as required by
`SPEC.md`: after `before_remove`, Symphony performs safe recursive deletion. The implemented
`workspace.provider: harness` extension instead makes the repository hook own teardown when generic
deletion would bypass resource release or Git worktree bookkeeping. This mode requires both
`after_create` and `before_remove`. A failed or incomplete teardown is retained and logged; Symphony
never silently falls back to generic deletion. No new repository should adopt this extension; it
is isolated behind a legacy driver until all existing consumers and receipts are drained.

## Delivery evidence

### Phase 1 — safe foundation: complete

- Strict TypeScript package, deterministic formatting, type checking, unit tests, and build.
- Domain records and typed errors.
- Workflow path selection, YAML/body parser, adapter-owned provider config resolution, defaults,
  strict Liquid rendering, and last-known-good live reload.
- Workspace key/path safety, bounded hook runner, lifecycle manager, and hook context.

Gate: every applicable item in SPEC sections 17.1 and 17.2 passes deterministically.

### Phase 2 — GitHub Projects boundary: complete

- `gh api graphql` client with pagination and stable error categories.
- Exactly the two required tracker reads: state-list fetch and opaque-ID refresh.
- One-repository board scoping and explicit `dispatchable` semantics.
- Normalization tests, malformed-record behavior, and a published adapter profile.

Gate: SPEC section 17.3 plus fixture-driven GraphQL contract tests; no live board mutation.

### Phase 3 — Codex app-server boundary: complete

- Generate schemas from the installed Codex binary and pin the targeted protocol contract.
- JSONL transport, initialize/thread/turn lifecycle, continuation turns, bounded input, stall and
  turn timeouts, event/token normalization, and deterministic shutdown.
- Host-side provider tools with session-snapshot binding and child credential scrubbing.

Gate: SPEC section 17.5 uses a scripted app-server subprocess. The installed Codex schema and CLI
version are pinned separately from the fake behavior contract.

### Phase 4 — orchestration authority: complete

- Candidate filtering/sort, claims, global and per-state concurrency.
- Worker lifecycle, continuation and exponential retry queues.
- Active-run and newly-terminal poll reconciliation, stall termination, and startup cleanup.
- Structured logs and a read-only runtime snapshot.

Gate: SPEC sections 17.4 and 17.6 with fake time, fake adapters, and controlled workers.

### Phase 5 — daemon and isolated integration: complete

- CLI path precedence, startup validation, signal handling, exit codes, and host-lifecycle tests.
- A documented legacy repository-owned workflow template and harness contract.
- System-level deployment guidance plus a checked per-user systemd unit for supervising one daemon
  per repository without tying its lifetime to a terminal or coding-agent session.
- An isolated daemon journey that releases an inactive Human Review claim, observes a later
  terminal transition on the normal poll cadence, and invokes the legacy repository-owned teardown
  hook.

Gate: SPEC section 17.7 and an isolated end-to-end process fixture. The fixture composes real
workflow, adapter, workspace, Codex transport, runner, orchestration, continuation, and release
boundaries without external mutation.

### Estate alignment foundation

- One SQLite-backed WorkSession aggregate for tracker origin, with pinned inputs, plans/decisions,
  session-level human attachment, attempt/runtime leases, durable retry, managed-workspace leases,
  preparation outcomes, materialization/proof/delivery state, effect intents, transactional v1→v2
  migration, integrity checking, and backup.
- Cross-process lease exclusion, stale runtime fencing, restart recovery, and an idempotent
  fresh-attempt tracker effect.
- One `RepositoryDriver` port with directory/harness compatibility routes and a managed
  Git-worktree implementation proven against real temporary Git repositories.
- Strict thin product-profile plus operator deployment-binding composition, exact-revision context
  resolution, disjoint state/workspace roots, and refusal of positional managed-Git authority.
- One `PreparationDriver` port with a fail-closed Bubblewrap/pnpm implementation and real process
  fixtures proving frozen install, lifecycle-script suppression, minimal environment, host-path
  non-observation, and cleanup.
- A full accepted-binding managed daemon fixture with no product lifecycle hooks; mutable profile
  and prompt copies cannot replace its pinned context.
- A deterministic systemd user-scope boundary with lease-retention tests and an opt-in host probe
  proving a detached descendant is removed after its app-server parent exits.
- A trusted source materializer that captures one bounded complete manifest, constructs Git objects
  through a private index, and advances only the fenced managed branch from its pinned base.
- A provider-neutral delivery coordinator whose durable effects bind push, PR, protected exact-head
  checks/proof, grant-constrained merge, remote branch release, and guarded local cleanup. Provider
  credentials remain in an operator-selected child process and never enter candidate execution or
  WorkSession state.

Gate: the complete `pnpm check` and `pnpm build` commands after the specification and operator docs
are synchronized. WCP protected proof v2 is an external input to the exact-head correlation; a real
consumer journey remains a separate estate capability.

### Next estate gate — protected proof, delivery, and real target journey

- Build WCP protected proof v2 and prove a capacity-one disposable-runner canary before enabling a
  product consumer.
- Compose Symphony's delivered materialization/provider/coordinator ports into tracker-policy
  reconciliation, then run the real Dyslexify profile with a disposable board item and managed
  workspace.
- Prove terminal cleanup, cancellation, retry, restart recovery, token separation, protected proof,
  and one complete `Todo → Human Review → Merging → Done` path.
- Record commands, artifact IDs, and cleanup evidence rather than relying on a green summary.

## Target integration prerequisites and scope boundaries

New targets use the Symphony-owned repository driver; they never solve integration by adding a
repository bootstrap hook. Repository and board facts remain external inputs:

- Dyslexify is the first migration pilot only after WCP proof v2, a capacity-one canary, durable
  delivery, and accepted doctrine routing exist.
- Storefronts and Project Tracker retain the legacy driver until the pilot proves replacement;
  Core and other products require separate onboarding decisions.
- Required product checks, proof meaning, workpad conventions, lane-vocabulary rules, and board
  creation live in their owning repositories. Symphony consumes their contracts; it does not absorb
  them.
- Concurrency remains one until target-repository capacity has been measured and reclaimed.

## Completion rule

The legacy Node profile remains conformant, and the managed WorkSession/repository/preparation
foundation is complete only when its synchronized SPEC matrix, `pnpm check`, and `pnpm build` pass
from one revision. Production readiness remains a separate gate: protected WCP evidence, durable
delivery, an accepted doctrine snapshot, and a real pilot must correlate one immutable source and
pull request through terminal cleanup. A passing local fixture is not that deployment claim.
