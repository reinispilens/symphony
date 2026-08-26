# Symphony Service Specification

Status: Draft v1 (language-agnostic)

Purpose: Define a service that orchestrates coding agents to get project work done.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

## 1. Problem Statement

Symphony is an orchestration system with two initiation paths. Its daemon continuously reads
authorized work from a configured issue tracker, creates an isolated workspace for each item, and
runs a coding-agent session inside that workspace. Its local manual surface records a boardless
human-controlled WorkSession without starting an agent or adopting the human checkout.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It makes an existing human-driven coding conversation durable without pretending the board or a
  Symphony-spawned agent owns that work.
- It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue
  workspace directories.
- It keeps portable product identity and authoring context in-repo while keeping host/runtime
  authority in an independently controlled deployment binding.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Implementations are expected to document their trust and safety posture explicitly. This
specification does not require a single approval, sandbox, or operator-confirmation policy; some
implementations target trusted environments with a high-trust configuration, while others require
stricter approvals or sandboxing.

Important boundary:

- Symphony is a scheduler/runner and tracker reader.
- Ticket writes (state transitions, comments, PR links) are typically performed by the coding agent
  through provider-native tools executed by Symphony with the configured tracker credential.
- When tracker credentials are supplied through host-side secret references, the coding-agent child
  process does not need a duplicate tracker login or direct access to raw tracker credentials.
- A successful run can end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded concurrency.
- Maintain one durable WorkSession authority for pinned inputs, decisions, attachments, attempts,
  runtime/workspace leases, retries, sagas, and restart reconciliation, with process-local maps
  only as projections.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Compose managed runtime behavior from an exact-revision product profile/context plus an
  operator-owned deployment binding; retain repository-owned `WORKFLOW.md` only for compatibility.
- Expose operator-visible observability (at minimum structured logs).
- Recover after process death from a transactional state store plus independent tracker,
  Git/filesystem, and provider observations; never reconstruct missing Symphony authority silently.
- Let a local human start, attach, plan, steer, restart, and inspect a boardless WorkSession through
  the same store and accepted authority used by tracker-origin work.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit tickets, PRs, or comments. (That logic lives in the
  workflow prompt and agent tooling.)
- Mandating strong sandbox controls beyond what the coding agent and host OS provide.
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.

## 3. System Overview

### 3.1 Main Components

1. `Deployment / Workflow Loader`
   - For managed Git, validates an operator binding, reads the accepted product profile and context
     from its exact Git revision, and returns one pinned workflow snapshot.
   - For compatibility, reads `WORKFLOW.md`, parses YAML front matter and prompt body, and returns
     `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Issue Tracker Adapter`
   - Fetches issues in requested active and terminal states for polling/reconciliation.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes tracker payloads into a stable issue model.
   - MAY expose provider-native agent tools without adding provider-specific write APIs to the
     orchestrator.

4. `Orchestrator`
   - Owns the poll tick.
   - Coordinates transitions through the durable state-store port.
   - Decides which issues to dispatch, retry, stop, or release.
   - Keeps process-local workers, timers, and metrics as replaceable projections.

5. `Symphony State Store`
   - Owns WorkSessions, revisions, pinned inputs, decisions, human attachments, attempts, runtime
     leases, workspace leases, durable retries, materialization/proof/delivery state, and
     external-effect intents.
   - Provides transactional mutation, fencing, integrity checks, and backup.

6. `Repository Driver`
   - Maps issue identifiers to workspace paths.
   - Implements managed Git-worktree lifecycle or an explicitly selected compatibility mode.
   - Records ownership before external effects and independently verifies guarded cleanup.

7. `Preparation Driver`
   - Performs optional dependency preparation after the repository workspace is ready.
   - Records inputs and outcome; the built-in pnpm driver runs fail-closed in a restricted sandbox.

8. `Agent Runner`
   - Receives an already-authorized workspace.
   - Builds prompt from issue + workflow template.
   - Launches the coding agent app-server client.
   - Streams agent updates back to the orchestrator.

9. `Interactive WorkSession Application Service`
    - Starts a boardless human-controlled WorkSession from an exact managed binding.
    - Records plans, steering, and a read-only observation of a human-owned checkout.
    - Uses the same state-store port while remaining independent of CLI rendering and tracker APIs.

10. `Status Surface`
    - Presents the required manual WorkSession projection and MAY also present daemon runtime status
      through a terminal, dashboard, or other operator-facing view.

11. `Logging`
    - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Symphony is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for ticket handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `State and Coordination Layer` (store + orchestrator)
   - WorkSessions, pinned inputs, decisions, transactions, leases, polling, issue eligibility,
     concurrency, durable retries, sagas, and reconciliation.

4. `Execution Layer` (repository + preparation + agent subprocess)
   - Managed Git/filesystem lifecycle, dependency preparation, and coding-agent protocol.

5. `Integration Layer` (selected tracker adapter)
   - API calls and normalization for tracker data.
   - Provider-native agent tools and centralized tracker authentication.

6. `Observability Layer` (logs + OPTIONAL status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- One configured issue tracker API.
- Local filesystem for state, workspaces, and logs.
- SQLite binding providing transactions, integrity checking, and online backup.
- Git CLI when the managed Git-worktree driver is selected.
- Bubblewrap and pnpm when the built-in pnpm preparation driver is selected.
- Coding-agent executable that supports the targeted Codex app-server mode.
- Host environment authentication for the issue tracker and coding agent. Host-side tracker secret
  environment variables SHOULD NOT be inherited by the coding-agent child process.

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized schedulable work item used by orchestration, prompt rendering, and observability output.
The name `Issue` is generic in this specification; an adapter MAY map it from a ticket, card,
project item, or another provider-native work object.

Fields:

- `id` (string)
  - REQUIRED stable dispatch identity within the configured tracker scope.
  - Opaque to the orchestrator. It MAY be a project-item or board-entry ID instead of the
    provider's underlying ticket ID.
- `native_ref` (object or null)
  - OPTIONAL non-secret provider identifiers needed by provider-native tools.
  - Opaque to the orchestrator and preserved for prompt/tool context.
- `identifier` (string)
  - REQUIRED human-readable ticket key (example: `ABC-123`).
  - MUST be unique within the configured tracker scope because it names workspaces and
    operator-facing routes. An adapter spanning multiple namespaces MUST disambiguate it.
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `state` (string)
  - REQUIRED current provider-native state name.
- `state_version` (string or null)
  - OPTIONAL opaque version of the current state assignment. A changed value means the issue
    entered or re-entered its current state.
  - REQUIRED at dispatch time when the state is configured in `fresh_attempt_states`; absence must
    refuse that attempt before launching the coding agent.
- `branch_name` (string or null)
  - Tracker-provided branch metadata if available.
- `url` (string or null)
- `assignee_id` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Best-effort provider metadata. Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `dispatchable` (boolean)
  - REQUIRED adapter-derived eligibility for provider-specific rules that the generic scheduler
    cannot infer safely, such as assignment, board membership, or blocker semantics.
  - The orchestrator still applies configured state, label, claim, retry, and concurrency rules.
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Snapshot

Pinned managed composition or parsed compatibility `WORKFLOW.md` payload:

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from the accepted managed binding/profile composition or, on the
compatibility path, `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal issue states
- concurrency limits
- coding-agent executable/args/timeouts
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one issue identifier.

Fields (logical):

- `path` (absolute workspace path)
- `workspace_key` (collision-resistant sanitized issue identifier)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.5 WorkSession

One durable authoring trajectory. Tracker dispatch and explicit local human initiation are the two
implemented origins; both use this aggregate so manual control does not require a second store.

Fields (logical):

- `id` (opaque stable identifier)
- `revision` (monotonically increasing optimistic-concurrency revision)
- `origin`
  - `tracker`: tracker kind, repository identity, opaque issue ID, display identifier, and URL
  - `interactive`: repository identity and initiating actor
- `repository_identity`
- `intent`
- `status` (`active`, `completed`, or `cancelled`)
- `doctrine_snapshot` (portable repository/path/revision/digest, or null only during the documented
  doctrine-migration compatibility window)
- `accepted_configuration` (the immutable product-profile reference, resolved authoring-context
  manifest and entries, deployment-binding identity/digest, accepted-governance manifest reference,
  complete typed tracker-policy snapshot with its source reference, and optional version-1 product
  compatibility or exact product-owner delivery grant plus operator protected-proof authority)
- `controller_assignment` (kind, controller ID, monotonically increasing fencing generation)
- ordered decisions/steering/exceptions, with accepted doctrine and `GP-xx` identity on exceptions
- zero or one revisioned plan with acceptance criteria
- zero or one human-owned workspace attachment, outside every Attempt and lease
- zero or more child attempts
- zero or one durable retry intent
- append-only source-materialization records, including the bounded exact input manifest used to
  produce the tree and commit
- protected-proof correlations and typed delivery state binding immutable local/remote head, PR,
  exact-head required checks, merge, remote-branch release intent, and local cleanup
- append-only terminal delivery history when a later Rework/fresh Attempt begins a new delivery;
  prior evidence is archived in the same aggregate rather than overwritten

The WorkSession is Symphony's aggregate root. Tracker comments, filesystem receipts, logs, and
runtime snapshots MAY project it but MUST NOT become competing writers.

#### 4.1.6 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `id` (opaque stable identifier)
- `ordinal` (positive integer unique inside the WorkSession)
- `tracker_attempt` (integer or null, compatibility prompt/retry counter)
- `fresh_attempt_generation` (string or null)
- `started_at`
- `status`
- `error` (OPTIONAL)
- `runtime_lease` (holder, token, controller generation, status, acquired/renewed/expires/released)
- `workspace_lease` (zero or one, typed by ownership mode)
- `preparation` (zero or one driver-versioned command, manifest/lock/input digests, dependency-policy
  snapshot, private-cache path, and four-way outcome)
- runtime process/thread correlation (non-authoritative)

At most one attempt in an active WorkSession may hold an active runtime lease, regardless of its
expiry timestamp. Expiry makes the lease eligible for reconciliation; it does not release
authority. A runtime write MUST present the attempt ID, lease token, and controller generation that
authorized it.

#### 4.1.7 Live Session (Agent Session Metadata)

State tracked while a coding-agent subprocess is running.

Fields:

- `session_id` (string, `<thread_id>-<turn_id>`)
- `thread_id` (string)
- `turn_id` (string)
- `codex_app_server_pid` (string or null)
- `last_codex_event` (string/enum or null)
- `last_codex_timestamp` (timestamp or null)
- `last_codex_message` (summarized payload)
- `codex_input_tokens` (integer)
- `codex_output_tokens` (integer)
- `codex_total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `turn_count` (integer)
  - Number of coding-agent turns started within the current worker lifetime.

#### 4.1.8 Retry Entry

Durable scheduled retry intent for a WorkSession. A process timer is only a wake-up projection.

Fields:

- `work_session_id`
- `attempt` (integer, 1-based for retry queue)
- `due_at` (wall-clock timestamp persisted durably)
- `recorded_at` (wall-clock timestamp)
- `error` (string or null)
- `kind` (`continuation`, `failure`, or `fresh_handoff`)
- `fresh_attempt_generation` (string or null)

#### 4.1.9 Workspace Lease

Durable Symphony ownership record for the workspace used by an attempt.

Modes:

- `managed`: created by a Symphony RepositoryDriver; guarded cleanup is permitted only through its
  lease and independent repository/filesystem verification.
- `legacy-directory` or `legacy-hook`: compatibility state whose cleanup semantics remain with the
  selected legacy driver.

`attached` is deliberately not a workspace-lease mode. A human-owned checkout is recorded once on
the WorkSession root as a `HumanWorkspaceAttachment`; RepositoryDriver cleanup and materialization
accept only the managed/compatibility lease union and therefore cannot receive that attachment.

A managed Git-worktree lease records repository/profile identity and digest, source root,
workspace root/path/key, immutable base ref/SHA, branch, driver/version, lease token, controller
generation, fresh-attempt generation, and lifecycle phase. Phases are `allocating`, `provisioned`,
`ready`, `superseded`, `removal_pending`, `removed`, or `retained`. `superseded` records an atomic
ownership transfer to a later Attempt that reuses the same physical worktree; it is not a second
live cleanup claim.

#### 4.1.10 Human Workspace Attachment

A session-level reference to a checkout created and owned by a human or external tool. It records
an opaque ID, canonical absolute path, repository identity, observed head/change facts (or an
explicit `unknown` inspection only after safe v1 migration), attaching actor, timestamp,
`ownership: human`, and `removal_policy: never`.

Recording an attachment creates no Attempt, runtime lease, or workspace lease. An attachment
cannot coexist with an active runtime or live Attempt workspace lease, cannot be claimed by two
active WorkSessions, and prevents Attempt admission until a future explicit handoff contract
changes ownership. Symphony MUST NOT reset, clean, prepare, materialize, or remove it.

#### 4.1.11 External Effect Intent

Transactional record written before a non-database mutation. It contains an ID, WorkSession ID,
kind, stable idempotency key, controller generation, typed JSON payload, status
(`pending`, `applied`, or `failed`), result, and timestamps. Symphony MUST NOT hold a database
transaction open while calling Git, Codex, a tracker, Git hosting, or a proof provider.

#### 4.1.12 Orchestrator Runtime State

Process-local projection owned by the orchestrator. It is not the durable authority.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `issue_id -> running entry`)
- `claimed` (set of issue IDs reserved/running/retrying)
- `retry_attempts` (map `issue_id -> timer/projection of the durable RetryEntry`)
- `completed` (set of issue IDs; bookkeeping only, not dispatch gating)
- `codex_totals` (aggregate tokens + runtime seconds)
- `codex_rate_limits` (latest rate-limit snapshot from agent events)

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for tracker refresh calls and internal map keys.
  - Treat it as an opaque dispatch identity; do not assume it is the provider's underlying ticket
    ID.
- `Native Ref`
  - Preserve as opaque non-secret data for provider-native agent tools and prompt rendering.
  - Never use it as an orchestrator map key or interpret provider-specific fields in core logic.
- `Issue Identifier`
  - Use for human-readable logs and workspace naming.
  - Require uniqueness within the configured tracker scope.
- `Workspace Key`
  - Derive from `issue.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - If sanitization changes the identifier, append a stable hash suffix of the original identifier
    with at least 64 bits of entropy using only allowed workspace-key characters, making keys for
    distinct identifiers that sanitize to the same text collision-resistant.
  - Use the resulting value for the workspace directory name.
- `Normalized Issue State`
  - Compare states after trimming surrounding whitespace and applying `lowercase`.
- `WorkSession ID`
  - Use the opaque state-store identity for the durable aggregate and cross-system correlation.
  - Never derive it from a tracker identifier, branch, path, or Codex thread.
- `Attempt ID`
  - Use the opaque child identity for one fenced execution inside the WorkSession.
- `Runtime Session ID`
  - Compose from coding-agent `thread_id` and `turn_id` as `<thread_id>-<turn_id>`.
  - Treat it only as runtime correlation, never as WorkSession or Attempt authority.

## 5. Deployment and Workflow Inputs

### 5.0 Managed Deployment Authority

Managed Git worktrees MUST start from an operator-owned deployment binding supplied with
`--binding`. A positional or default repository-owned `WORKFLOW.md` MUST NOT authorize
`workspace.provider: git-worktree`.

Managed configuration composes three independently validated authorities:

1. A product-owned repository profile, read from the exact Git commit selected by the binding.
2. An operator-owned deployment binding stored outside product source, Symphony state, and managed
   workspace roots.
3. An accepted governance publication in an owner or organization `.github` repository, selected by
   the binding at one exact manifest commit and digest. The manifest identifies one accepted
   doctrine blob and one accepted tracker-policy blob at an exact ancestor commit and digest.

The version-1 compatibility repository profile is a strict JSON object with:

- `schemaVersion: 1`
- `repositoryIdentity`: canonical `owner/repository`
- `baseRef`: full allowed Git ref
- `authoringContext.promptPath`: repository-relative prompt path
- `authoringContext.paths`: unique repository-relative context paths
- `preparationClass`: `none` or `pnpm`

Version 2 adds one required `deliveryGrant`: `authority` is `owner-gated` or `full-in-scope`,
`governingPolicy` is one portable `.github` repository/path/exact-revision/digest reference, and
`requiredChecks` is a non-empty sorted unique list. The profile still MUST NOT contain tracker
configuration, credentials, source/state/workspace paths, branch namespace, concurrency, runtime
executables/timeouts, process containment, or proof/delivery commands.

The version-1 compatibility deployment binding is a strict JSON object with:

- its schema version and stable binding ID;
- product-profile repository identity, source root, repository-relative path, exact lowercase
  40-character commit ID, and SHA-256 content digest;
- pairwise-disjoint state and managed-workspace roots plus an allowed branch prefix;
- an exact regular non-symlink Git executable outside every governed root;
- tracker provider/routing, polling, concurrency, and retry limits;
- preparation authority that is `null` exactly when the accepted profile selects `none`; when the
  profile selects `pnpm`, a timeout, exact Node, pnpm-entry-point, and Bubblewrap paths, and an
  offline dependency policy naming its stable ID, credential-free approved HTTPS registry
  identity, real seed-store root, and exact pnpm version;
- exact Codex executable and runtime timeouts; and
- `systemd-user-scope` containment with a shutdown timeout and exact `systemd-run` and `systemctl`
  executable paths.

Version 2 adds one operator-owned `deliveryProvider` with protocol version 1, an exact executable,
positive timeout, and sorted unique uppercase secret-environment names. It MUST be present exactly
when the accepted profile contains a delivery grant. The executable is resolved as a regular
non-symlink file outside product, state, and workspace roots. Every named secret must exist, is
scrubbed from the coding-agent child, and is passed only to the separately spawned provider; no
credential value enters a WorkSession or provider request.

Version 3 adds one required `governance` authority, replaces copied global tracker policy with a
thin tracker binding, and requires each non-null delivery provider to carry a `proofAuthority`.
`governance` contains the `.github` repository identity, an absolute trusted checkout root, and a
manifest path/full commit/digest. The thin tracker contains only `kind` plus provider-owned routing
coordinates. Required/excluded driver labels, active/terminal/fresh-Attempt states, and the
fresh-Attempt failure state MUST be derived from the accepted tracker-policy blob; they MUST NOT be
repeated in version 3.

Provider-native candidate status tools MUST follow the same rule. In a managed WorkSession their
targets are exactly the non-terminal lanes whose pinned `writers` include `agent`; a provider-local
target list MUST NOT widen or replace that authority. Terminal lifecycle transitions such as
delivery-complete → `Done` remain available only through the typed tracker control.

The proof authority is operator-owned transport authority, not product proof meaning. It identifies
one check already named by the accepted product delivery grant, the exact
`pull_request_target` caller workflow path, and an exact reusable control workflow by
repository/path/full commit. It MUST be copied into the WorkSession accepted configuration. A
historical version-2 provider has null proof authority and cannot be used to admit protected proof.

The accepted-governance manifest is a strict portable JSON document containing its schema version,
`.github` repository identity, `acceptedRevision`, and distinct doctrine/tracker-policy artifact
paths and digests. The tracker policy is also strict and contains one stable policy ID, exactly the
`direct` and `symphony` driver selectors, unique lane records, the `owner-gated` and `full-in-scope`
delivery profiles, and supported continuation/failure/Rework semantics plus an explicit
fresh-Attempt failure lane. Every lane declares writers, active/terminal/authoring/fresh-Attempt
bits, and every delivery-operation bit. Invalid combinations such as inactive authoring, terminal
execution, fresh Attempt without authoring, merge without proof observation, owner-gated merge, or
an agent-selectable Merging lane MUST be refused.

Versions 1 and 2 remain parseable for historical inspection and controlled migration. Because they
do not select accepted governance, a managed WorkSession created from either version MUST NOT start
a new Attempt after the governance gate is installed. Historical null governance values remain
readable and MUST NOT be silently filled from current deployment state.

Resolution MUST:

1. Prove the binding is a regular non-symlink file outside
   governance/product/state/workspace roots.
2. Prove product and governance source roots are exact top-level Git worktrees with matching origin
   identities, contain no symlink substitution, and are disjoint from one another plus state and
   workspace roots.
3. For binding version 3, read the manifest from its exact publication commit, verify its digest and
   repository identity, and prove its accepted artifact commit is an ancestor of that publication.
4. Read doctrine and tracker policy as exact regular Git blobs at the manifest's accepted commit;
   enforce byte/UTF-8/schema bounds and verify both manifest-declared digests. Never consult mutable
   working-tree copies or candidate bytes.
5. Read the profile blob and every named context blob from the binding's exact accepted product
   commit, never from mutable working-tree files; verify the profile digest and repository identity.
6. Prove the accepted profile revision is an ancestor of the resolved allowed base commit.
7. Require a version-2 product delivery grant's governing-policy reference to equal the resolved
   accepted tracker-policy source reference exactly. Derive tracker runtime selectors/lanes/retry
   targets from that policy.
8. Require the operator proof authority's named check to exist in the accepted product grant and
   validate both caller and control paths as GitHub workflow files plus the control revision as a
   full immutable commit.
9. Bound individual and aggregate context bytes, reject duplicate/reserved/escaping paths, and
   record a deterministic context manifest plus entry digests.
10. Prove the Git, Codex, delivery-provider, and systemd executables are regular non-symlink paths
   outside all governed roots. When `pnpm` is selected, also prove the preparation
   executables/entry point are regular non-symlink paths outside those roots, contain no symlink
   component, and report the exact policy version. Refuse missing or unused pnpm authority instead
   of allowing the binding to weaken or broaden the product-selected class.
11. When `pnpm` is selected, prove the dependency seed is a real root disjoint from governance,
    product source, Symphony state, and managed workspaces; normalize and digest the offline
    dependency policy.
12. Construct one pinned workflow snapshot and record doctrine, governance manifest, complete typed
    tracker policy, product profile, context, binding, delivery grant, and proof authority
    identities/values on the WorkSession before its first Attempt.

The pinned managed source MUST NOT live-reload. Changing a binding, accepted publication, or
accepted product revision requires a clean daemon restart. A newer deployment publication applies
only when creating a new WorkSession; recovery of an existing WorkSession MUST use its stored typed
policy value. The binding may select accepted revisions but MUST NOT rewrite their bytes, publish
doctrine, or redefine product proof meaning.

### 5.0.1 Trusted source materialization and delivery

After a managed Attempt completes, its runtime lease MUST be released only after descendant
quiescence is proven. Source materialization then operates under the recorded controller generation,
Attempt ID, and managed-workspace lease token. It MUST:

1. Record an idempotent intent before Git-ref mutation and acquire one cross-process workspace
   fence under the operator state root.
2. Independently verify the linked worktree, common Git directory, recorded branch/base, disabled
   sparse checkout, absent executable filters, absent active `info/exclude`, and absent submodules
   or nested repositories.
3. Read tracked current bytes (including deletions) plus non-ignored untracked bytes without
   following file symlinks; exclude untracked runtime/cache segments and refuse them when tracked.
4. Bound paths, files, individual bytes, and aggregate bytes; record the complete ordered manifest,
   content digests, Git blob identities, origin, kind, and mode.
5. Build through a Symphony-owned temporary index with filters/hooks disabled, detect concurrent
   mutation, write one deterministic commit, and atomically advance only the recorded branch from
   its expected old SHA. A completed branch MUST never be rolled back by a later failed resume.

Remote delivery is a durable saga. Every mutation has a stable WorkSession idempotency key and
controller generation and runs through the separately trusted provider process. The request carries
the pinned product grant, pinned operator proof authority, current tracker authority, repository
identity, exact branch/base/head, and no credentials. The saga MUST observe before mutation,
re-observe after every ambiguous process outcome, and never repeat an applied effect whose provider
truth disappeared.

Only the exact materialized commit may be pushed. PR identity must match its exact branch, base, and
head. Every required check and admitted proof correlation must name that same head; an unrelated or
stale green check is a refusal. A protected WCP check is admitted only when the provider also reads
the protected plan/result artifacts and verifies their repository, workflow run ID/attempt, source
SHA, canonical plan digest, result kind, and check-run correlation. Before reading those artifacts,
the provider MUST verify host-authenticated run metadata: GitHub Actions ownership, exact
`pull_request_target` event, repository, immutable head, caller workflow path, and an exact
referenced reusable workflow repository/path/SHA matching the WorkSession's pinned proof authority.
The plan's control-workflow and control-source identities MUST match that host truth. A green host
check, a self-consistent artifact pair, or a candidate-selected reusable workflow alone is not
proof.

For tracker-origin work, each operation requires the intersection of the WorkSession's pinned lane
policy, its pinned product delivery profile, and current issue/provider facts. `owner-gated` never
produces a merge intent. `full-in-scope` may merge only when current tracker authority also permits
it. After an exact merge is observed, a durable release intent removes only the exact remote branch,
then the repository driver performs guarded local worktree/branch cleanup. Only after cleanup may a
typed, revision-aware tracker effect move the item to an agent-writable terminal lane. Waiting for
checks or owner action returns control to the daemon and MUST NOT consume an agent turn or sleep
inside one.

If a current lane requires a fresh Attempt while an unmerged delivery exists, Symphony MUST first
close the exact pull request, release the exact remote branch, and perform guarded local cleanup.
Those steps use durable intent and observation like ordinary delivery. Only after abandonment is
recorded may the next fresh workspace/Attempt be admitted; prior terminal delivery evidence remains
append-only history.

### 5.0.2 Managed runtime policy

For a managed Git Attempt, repository files MUST NOT select the app-server command, approval
policy, sandbox policy, writable roots, environment, process boundary, or cleanup behavior.
Symphony MUST:

- launch the binding's exact Codex executable with the single `app-server` argument and no login
  shell;
- set approval to `never`, thread sandbox to `workspace-write`, and an exact per-turn
  `workspaceWrite` policy with network, `/tmp`, and ambient `TMPDIR` excluded;
- grant only the managed worktree and one runtime-lease-private temp directory under the state
  root;
- scrub tracker secrets from the child environment;
- wrap the command in a deterministic WorkSession/controller-owned systemd user scope with
  `KillMode=control-group`, collection enabled, and systemd environment expansion disabled; and
- on every terminal/cancellation/recovery path, signal and observe the full scope empty before
  removing private runtime state or releasing/expiring the runtime lease.

App-server/process-group exit alone is not quiescence proof. If the user manager cannot be
contacted, scope state is malformed, or descendants remain after bounded TERM/KILL escalation,
Symphony MUST retain the active runtime lease and refuse replacement dispatch.

## 5.1 Compatibility Workflow Specification (Repository Contract)

### 5.1.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 5.1.2 File Format

`WORKFLOW.md` is a Markdown file with OPTIONAL YAML front matter.

Compatibility design note:

- `WORKFLOW.md` remains self-contained for existing directory/harness consumers. It is not the
  onboarding contract for new managed repositories.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter MUST decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 5.1.3 Front Matter Schema

Top-level keys:

- `tracker`
- `polling`
- `workspace`
- `repository`
- `preparation`
- `hooks`
- `agent`
- `codex`

Unknown keys SHOULD be ignored for forward compatibility.

Note:

- The workflow front matter is extensible. Extensions MAY define additional top-level keys without
  changing the core schema above.
- Extensions SHOULD document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.

#### 5.1.3.1 `tracker` (object)

Fields:

- `kind` (string)
  - REQUIRED for dispatch.
  - Selects one implementation-supported tracker adapter.
- `provider` (object)
  - Default: `{}`.
  - Adapter-owned configuration such as endpoint, scope/project selector, and credentials.
  - Core Symphony MUST preserve unknown keys and MUST NOT prescribe one cross-provider credential
    or scope schema.
  - Each adapter MUST document its required keys, defaults, secret keys, `$VAR_NAME` support, and
    validation errors.
  - If a documented secret `$VAR_NAME` resolves to an empty string, treat that secret as missing.
- `required_labels` (list of strings)
  - Default: `[]`.
  - An issue MUST contain every configured label to dispatch or continue.
  - Matching ignores case and surrounding whitespace.
  - Values MUST be non-blank and unique after matching normalization.
- `excluded_labels` (list of strings)
  - Default: `[]`.
  - An issue MUST contain none of the configured labels to dispatch or continue.
  - Matching ignores case and surrounding whitespace.
  - Values MUST be non-blank and unique after matching normalization.
  - The normalized required and excluded sets MUST NOT overlap.
- `active_states` (list of strings)
  - REQUIRED unless the selected adapter profile documents a default.
  - Values are provider-native state names compared case-insensitively by the scheduler.
- `terminal_states` (list of strings)
  - REQUIRED unless the selected adapter profile documents a default.
  - Values are provider-native state names compared case-insensitively by the scheduler.
- `fresh_attempt_states` (list of strings)
  - Default: `[]`.
  - Every entry MUST also be in `active_states`.
  - Each distinct tracker state version requires a newly provisioned attempt before agent launch.
- `fresh_attempt_failure_state` (string)
  - REQUIRED exactly when `fresh_attempt_states` is non-empty.
  - MUST be neither active nor terminal. The driver records a provisioning blocker before moving a
    refused attempt to this state.

#### 5.1.3.2 `polling` (object)

Fields:

- `interval_ms` (integer)
  - Default: `30000`
  - Changes SHOULD be re-applied at runtime and affect future tick scheduling without restart.

#### 5.1.3.3 `workspace` (object)

Fields:

- `provider` (`directory`, `git-worktree`, or `harness`)
  - Default: `directory`.
  - `git-worktree` remains parseable for migration diagnostics, but daemon admission refuses it;
    the managed driver is selected only by Section 5.0 binding composition.
  - `harness` is compatibility-only and requires `hooks.after_create` plus
    `hooks.before_remove`. New repository integrations MUST NOT select it.
- `root` (path string or `$VAR`)
  - Default: `<system-temp>/symphony_workspaces`
  - `~` is expanded.
  - Relative paths are resolved relative to the directory containing `WORKFLOW.md`.
  - The effective workspace root is normalized to an absolute path before use.

#### 5.1.3.4 `repository` (object)

Frozen compatibility shape superseded by the Section 5.0 product profile and binding:

- `identity` (string `owner/repository`)
  - REQUIRED when `workspace.provider: git-worktree`.
  - MUST match the selected tracker provider's owner/repository when that adapter exposes them.
  - The driver MUST independently verify both the accepted source checkout's configured Git `origin`
    hostname and owner/repository against the tracker-resolved provider identity. The hostname is
    derived from the tracker profile rather than duplicated in this object.
- `base_ref` (full `refs/heads/*` or `refs/remotes/*` ref)
  - REQUIRED for managed Git worktrees.
  - Resolved from the accepted source checkout and pinned to a full immutable commit SHA before any
    worktree mutation.
- `branch_prefix` (safe relative Git namespace ending in `/`)
  - REQUIRED for managed Git worktrees.
  - MUST reject leading slash, `..`, `@{`, backslash, and other invalid/broadening forms.

This object is not managed deployment authority. New integrations use the strict profile/binding
split; positional compatibility startup MUST refuse this shape when it selects `git-worktree`.

#### 5.1.3.5 `preparation` (object)

Fields:

- `driver` (`none` or `pnpm`)
  - Default: `none`.
  - `pnpm` requires a fenced WorkSession attempt and managed workspace.
- `frozen_lockfile` (boolean)
  - Default and only accepted value: `true`.
- `lifecycle_scripts` (boolean)
  - Default and only accepted value: `false`.
- `timeout_ms` (positive integer)
  - Default: `300000`.

The built-in pnpm driver MUST fail closed if its exact operator-pinned sandbox, toolchain, or
offline seed is unavailable. Before execution it MUST validate regular non-symlink root and
workspace manifests, `pnpm-lock.yaml`, bounded `pnpm-workspace.yaml`/`.npmrc` inputs, the exact
`packageManager` version, every locked registry source, and every SHA-512 integrity record. The
first class MUST reject product pnpm hooks/configuration, runtime downloads, local/workspace/Git/SSH
dependencies, arbitrary package URLs/tarballs, unsupported lockfile shapes, and concurrent input
drift. It records manifest, lockfile, complete-input-set, command, and dependency-policy digests or
a typed preflight refusal.

Execution MUST use an attempt-private cache outside the worktree, a private writable snapshot of
the trusted seed's package index, and read-only content-addressed seed bytes. Bubblewrap MUST create
new user/mount/PID/network namespaces and expose only the managed worktree, private cache, exact
read-only toolchain/system roots, ephemeral `/tmp`/`proc`/`dev`, and the read-only seed. The process
receives a small explicit environment and no home, sibling repository, Symphony state,
host-control socket, tracker, delivery, or proof credential/path. It MUST run offline with a frozen
lockfile, store verification, lifecycle scripts and pnpm hooks disabled, runtime downloads disabled,
and copy imports. It MUST NOT share host networking or fall back to an unsandboxed/online command.
Cancellation and timeout MUST terminate the complete Bubblewrap process tree before returning.

The managed worktree is the cleanup unit. Preparation cleanup requires the matching WorkSession
controller generation and no active runtime lease, then removes only the exact recorded private
cache subtree after realpath, containment, type, and symlink checks; it does not need product-owned
receipts enumerating `node_modules` directories.

#### 5.1.3.6 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, OPTIONAL)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, OPTIONAL)
  - Runs before each agent attempt after workspace preparation and before launching the coding
    agent.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, OPTIONAL)
  - Runs after each agent attempt (success, failure, timeout, or cancellation) once the workspace
    exists.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, OPTIONAL)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, OPTIONAL)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Invalid values fail configuration validation.
  - Changes SHOULD be re-applied at runtime for future hook executions.

Managed `git-worktree` workflows MUST NOT define any lifecycle hook. Hooks remain valid for
`directory` and the transitional `harness` compatibility provider.

#### 5.1.3.7 `agent` (object)

Fields:

- `max_concurrent_agents` (integer)
  - Default: `10`
  - Changes SHOULD be re-applied at runtime and affect subsequent dispatch decisions.
- `max_turns` (positive integer)
  - Default: `20`
  - Limits the number of coding-agent turns within one worker session.
  - Invalid values fail configuration validation.
- `max_retry_backoff_ms` (integer)
  - Default: `300000` (5 minutes)
  - Changes SHOULD be re-applied at runtime and affect future retry scheduling.
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`trim + lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.

#### 5.1.3.8 `codex` (object)

Fields:

For compatibility workspace modes, Codex-owned config values such as `approval_policy`,
`thread_sandbox`, and `turn_sandbox_policy` remain protocol pass-through values defined by the
targeted Codex app-server version. To inspect the installed schema, run
`codex app-server generate-json-schema --out <dir>` and inspect the definitions referenced by
`v2/ThreadStartParams.json` and `v2/TurnStartParams.json`.

Managed Git does not consume this compatibility `codex` object. Its binding-owned launch and policy
are fixed by Section 5.0.1 and cannot be supplied through product configuration.

- `command` (string shell command)
  - Default: `codex app-server`
  - Compatibility modes launch this command via `bash -lc` in the workspace directory.
  - The launched process MUST speak a compatible app-server protocol over stdio.
- `approval_policy` (Codex `AskForApproval` value)
  - Default: implementation-defined.
- `thread_sandbox` (Codex `SandboxMode` value)
  - Default: implementation-defined.
- `turn_sandbox_policy` (Codex `SandboxPolicy` value)
  - Default: implementation-defined.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
- `read_timeout_ms` (integer)
  - Default: `5000`
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.

### 5.1.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime MAY use a minimal default prompt
  (`You are working on an issue from the configured tracker.`).
- Workflow file read/parse failures are configuration/validation errors and SHOULD NOT silently fall
  back to a prompt.

### 5.1.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 6. Configuration Specification

### 6.1 Configuration Resolution Pipeline

Configuration is resolved in this order:

1. Select the workflow file path (explicit runtime setting, otherwise cwd default).
2. Parse YAML front matter into a raw config map.
3. Apply built-in defaults for missing OPTIONAL fields.
4. Resolve `$VAR_NAME` indirection for config values that explicitly contain `$VAR_NAME`, plus any
   adapter-owned fallback environment names documented for omitted provider fields.
5. Coerce and validate typed values.

Environment variables do not globally override YAML values. They are used only when a config value
explicitly references them, or when an adapter profile documents a host-side fallback for an
omitted provider field. Such a fallback is adapter-local, not a cross-provider convention.

Value coercion semantics:

- Path/command fields support:
  - `~` home expansion
  - `$VAR` expansion for env-backed path values
  - Apply expansion only to values intended to be local filesystem paths; do not rewrite URIs or
    arbitrary shell command strings.
- Relative `workspace.root` values resolve relative to the directory containing the selected
  `WORKFLOW.md`.

### 6.2 Dynamic Reload Semantics

Dynamic reload is REQUIRED:

- The software MUST detect `WORKFLOW.md` changes.
- On change, it MUST re-read and either atomically re-apply the safe workflow fields or reject the
  reload while retaining the last-known-good snapshot.
- The software MUST adjust live behavior for polling cadence, concurrency limits, active/terminal
  states, codex settings, preparation policy, compatibility hooks, and prompt content for future
  runs.
- Tracker/repository identity, the trusted repository profile, and workspace provider/root are host
  topology. The Node implementation MUST reject their live change with an operator-visible
  restart-required error because the open state store and repository drivers are bound to the
  original topology.
- Reloaded config applies to future dispatch, retry scheduling, reconciliation decisions, hook
  execution, and agent launches.
- Implementations are not REQUIRED to restart in-flight agent sessions automatically when config
  changes.
- Extensions that manage their own listeners/resources (for example an HTTP server port change) MAY
  require restart unless the implementation explicitly supports live rebind.
- Implementations SHOULD also re-validate/reload defensively during runtime operations (for example
  before dispatch) in case filesystem watch events are missed.
- Invalid reloads MUST NOT crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

This validation is a scheduler preflight run before attempting to dispatch new work. It validates
the workflow/config needed to poll and launch workers, not a full audit of all possible workflow
behavior.

Startup validation:

- Validate configuration before starting the scheduling loop.
- If startup validation fails, fail startup and emit an operator-visible error.

Per-tick dispatch validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an
  operator-visible error.

Validation checks:

- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported.
- The selected adapter accepts `tracker.provider` after documented defaults and `$VAR`
  resolution.
- `codex.command` is present and non-empty.
- `workspace.provider` is supported.
- A managed Git-worktree workflow has a valid repository identity, tracker-resolved hostname, full
  base ref, safe branch prefix, no lifecycle hooks, and an identity matching adapter scope.
- `preparation.driver: pnpm` is selected only with the managed Git-worktree provider, retains a
  frozen lockfile, disables lifecycle scripts, and has a positive timeout.

### 6.4 Core Config Fields Summary (Cheat Sheet)

This section is intentionally redundant so a coding agent can implement the config layer quickly.
Extension fields are documented in the extension section that defines them. Core conformance does
not require recognizing or validating extension fields unless that extension is implemented.

- `tracker.kind`: string, REQUIRED, selects one supported adapter
- `tracker.provider`: object, default `{}`, adapter-owned endpoint/scope/auth settings
- `tracker.required_labels`: list of strings, default `[]`
- `tracker.excluded_labels`: list of strings, default `[]`
- `tracker.active_states`: list of provider-native state names, adapter-defined default
- `tracker.terminal_states`: list of provider-native state names, adapter-defined default
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path resolved to absolute, default `<system-temp>/symphony_workspaces`
- `workspace.provider`: `directory`, `git-worktree`, or compatibility-only `harness`; default
  `directory`
- `repository.identity`: `owner/repository`, REQUIRED for `git-worktree`
- `repository.base_ref`: full `refs/heads/*` or `refs/remotes/*`, REQUIRED for `git-worktree`
- `repository.branch_prefix`: safe namespace ending in `/`, REQUIRED for `git-worktree`
- `preparation.driver`: `none` or `pnpm`, default `none`
- `preparation.frozen_lockfile`: only `true`
- `preparation.lifecycle_scripts`: only `false`
- `preparation.timeout_ms`: positive integer, default `300000`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `codex.command`: compatibility shell command string
- `codex.approval_policy`: compatibility Codex value
- `codex.thread_sandbox`: compatibility Codex value
- `codex.turn_sandbox_policy`: compatibility Codex value
- `codex.turn_timeout_ms`: integer, default `3600000`
- `codex.read_timeout_ms`: integer, default `5000`
- `codex.stall_timeout_ms`: integer, default `300000`

## 7. Orchestration State Machine

The orchestrator is the only application component that requests scheduling transitions. Durable
mutations go through `SymphonyStateStore`; all worker outcomes are reported back to the orchestrator
and converted into explicit, transactional state changes. Process-local maps and timers are
projections, not competing authority.

### 7.1 Issue Orchestration States

This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal
claim state.

1. `Unclaimed`
   - Issue is not running and has no retry scheduled.

2. `Claimed`
   - A WorkSession active attempt/runtime lease or durable retry reserves the issue from duplicate
     dispatch.
   - The in-memory `claimed` set mirrors that durable fact for fast selection.

3. `Running`
   - Worker task exists and the issue is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a durable retry intent exists; a timer may mirror its due time.

5. `Released`
   - Claim removed because issue is terminal, non-active, missing, or retry path completed without
     re-dispatch.

Important nuance:

- A successful worker exit does not mean the issue is done forever.
- The worker MAY continue through multiple back-to-back coding-agent turns before it exits.
- After each normal turn completion, the worker re-checks the tracker issue state.
- If the issue is still in an active state, the worker SHOULD start another turn on the same live
  coding-agent thread in the same workspace, up to `agent.max_turns`.
- The first turn SHOULD use the full rendered task prompt.
- Continuation turns SHOULD send only continuation guidance to the existing thread, not resend the
  original task prompt that is already present in thread history.
- Once the worker exits normally, the orchestrator still schedules a short continuation retry
  (about 1 second) so it can re-check whether the issue remains active and needs another worker
  session.

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingAgentProcess`
4. `InitializingSession`
5. `StreamingTurn`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

Distinct terminal reasons are important because retry logic and logs differ.

### 7.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate issues.
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule continuation retry (attempt `1`) after the worker exhausts or finishes its in-process
    turn loop.

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `Codex Update Event`
  - Update live session fields, token counters, and rate limits.

- `Retry Timer Fired`
  - Re-fetch active candidates and attempt re-dispatch, or release claim if no longer eligible.

- `Reconciliation State Refresh`
  - Stop runs whose issue states are terminal or no longer active.

- `Stall Timeout`
  - Kill worker and schedule retry.

### 7.4 Idempotency and Recovery Rules

- WorkSession mutation MUST be transactional. Human/controller edits use an expected WorkSession
  revision; execution writes use the active attempt ID, runtime lease token, and controller
  generation. Managed-workspace transitions additionally use their workspace lease token.
- Acquiring a runtime lease MUST present the current controller generation and atomically refuse a
  stale controller or any second active lease for the WorkSession, including when the existing
  lease timestamp has expired and when two daemon processes race.
- Reconciliation MUST list expired candidates without mutating them, prove the exact managed
  descendant scope quiescent, then expire only the same attempt/token/generation in a fenced
  transaction. Observation failure retains the active lease and blocks replacement dispatch.
- `claimed` and `running` projection checks remain REQUIRED before requesting a lease, but they are
  not sufficient authority by themselves.
- Reconciliation runs before dispatch on every tick.
- Retry intent and external-effect intent MUST be durable before their timer/call is started.
- External effects use stable idempotency keys. Their result is recorded after independently
  observing the effect; no database transaction remains open across the external call.
- Restart recovery begins from the WorkSession store and then cross-checks tracker,
  Git/filesystem, and provider truth. Missing state cannot be reconstructed into cleanup authority.
- Startup cleanup sweeps every terminal item, while successful normal polls clean newly observed
  terminal items whose worker claims have already been released.

### 7.5 Durable State-Store Contract

The Node managed implementation uses one SQLite database at `<stateRoot>/state.sqlite`, where
`stateRoot` comes only from the operator binding and is disjoint from product and workspace roots.
Compatibility deployments retain `<workspace.root>/.symphony/state.sqlite`. The containing state
directory MUST be a real private directory (mode `0700` on POSIX) and the database MUST be a regular
non-symlink private file (mode `0600` on POSIX). The main database is created with that mode before
SQLite opens it so first-open `-wal` and `-shm` sidecars inherit the same private mode. Opening state through an unexpected file type or
symlink MUST fail closed.

The store MUST provide:

- versioned, transactional schema migration;
- foreign-key enforcement;
- WAL journaling and a durability synchronization mode appropriate for restart authority;
- bounded busy handling instead of unbounded hangs;
- an integrity check on open that also decodes every aggregate/effect and rejects disagreement
  between canonical documents and indexed relational projections;
- immediate write transactions or equivalent serialization across processes;
- monotonic row revisions and relational validation of decoded aggregate state;
- a backup operation that refuses overwrite and produces a private, independently reopenable copy;
- orderly close during daemon shutdown.

State is committed before an associated external effect and its observed result is committed after
the call. Reopening the database MUST be sufficient to discover active/expired leases, durable
retries, managed workspace phases, running/interrupted preparation, and pending effects. Logs,
tracker comments, workpads, candidate files, and legacy receipts MAY help explain or cross-check the
record but MUST NOT replace it.

### 7.6 Manual Interactive Control

The Node implementation exposes five local commands over the same `SymphonyStateStore` used by the
daemon:

```text
symphony work start  --binding <absolute-path> --intent <text>
symphony work attach --binding <absolute-path> --session <id> --expected-revision <n> --path <absolute-checkout>
symphony work plan   --binding <absolute-path> --session <id> --expected-revision <n> --file <plan.md>
symphony work steer  --binding <absolute-path> --session <id> --expected-revision <n> --message <text>
symphony work status --binding <absolute-path> --session <id> [--json]
```

Every invocation MUST receive and re-resolve the same exact absolute operator binding. The binding
names the private state root and accepted authority; a WorkSession ID identifies a record inside
that store but is not a global state-store locator. The implementation MUST NOT add a binding
registry, sidecar file, second database, or candidate-repository workflow path to compensate.

`start` MUST require binding schema version 3 with non-null accepted governance, pin the exact
product/context/binding/doctrine/policy references, derive the human controller from the local
operating-system identity, and create an `interactive` WorkSession. It MUST NOT read or mutate a
tracker, allocate a workspace, create an Attempt, launch an agent, invoke WCP, or begin delivery.
Manual commands MUST fully validate the configured delivery authority but MUST NOT require an
unused delivery secret to be present; no provider receives that secret during a record-only command.

`attach` MUST first fence the expected revision and active human controller, then perform only
read-only Git inspection with the binding's trusted Git executable and scrubbed Git environment. It
MUST canonicalize a nested directory to its real repository root; verify the accepted origin host
and owner/repository; record HEAD plus tracked, untracked, and ignored-change observations; and
refuse symlink aliases, another repository, a conflicting active workspace claim, or overlap with
state, managed-workspace, accepted-governance, or binding authority. The resulting session-level
attachment has `ownership: human` and `removal_policy: never` and creates no Attempt or lease.
Inspection MUST disable ambient Git configuration, hooks, fsmonitor, recursive submodules, and
refuse repository-configured executable clean/smudge/process filters before status evaluation.

`plan` MUST accept only a bounded regular non-symlink UTF-8 file containing exactly one `## Plan`
section and one non-empty `## Acceptance criteria` list. It replaces the current typed plan and
increments its version. The MVP retains the current plan, not superseded plan bodies; append-only
steering and doctrine exceptions provide the durable decision history.

`steer` MUST append one revision-fenced entry accepted by the active human controller. Text in the
exact form `EXCEPTION GP-xx: <reason>` becomes a doctrine-linked exception; malformed
`EXCEPTION...` text MUST be refused rather than silently stored as ordinary steering. The state
store records the trusted application's accepted actor; the manual application service MUST prove
that actor is its active human controller. A future tracker-origin structured human action has a
separate authentication seam and MUST NOT impersonate the tracker controller.

`status` is read-only and MUST return a versioned projection rather than a raw aggregate or database
row. It MAY display the checkout path and intentional plan/decision text, but MUST omit runtime and
workspace lease tokens, effect payloads, raw prompts, transcripts, environment values, and stored
provider errors. Repeated collections MUST be bounded with total/truncation metadata. Dirty
attached work is advisory. A clean observation is `protected` only when one passed proof matches
both its recorded immutable HEAD and the digest of the current plan; otherwise it is `unproven`.

These commands are a durable record/control surface for a human-driven session. They do not inject
context into an already-running coding client, spawn a replacement client, hand control to a board,
or broaden Symphony into a multi-repository program manager.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

At startup, the service validates config, opens and checks the state store, expires stale runtime
leases, restores durable retry admission from recorded due times, performs terminal cleanup reconciliation, schedules an
immediate tick, and then repeats every `polling.interval_ms`.

The effective poll interval SHOULD be updated when workflow config changes are re-applied.

Tick sequence:

1. Reconcile running authoring issues and expired runtime leases.
2. Run dispatch preflight validation.
3. Using the last-known-good compatibility workflow or the union of current and stored managed
   policies, fetch every lane required for authoring, delivery, or terminal reconciliation.
4. Resume persisted and lane-enabled delivery sagas without consuming agent slots.
5. Clean newly observed terminal workspaces that have no current claim or pending delivery.
6. If preflight failed, skip new authoring dispatch for this tick.
7. Sort authoring-eligible issues by dispatch priority.
8. Dispatch eligible issues while slots remain.
9. Notify observability/status consumers of state changes.

Per-tick validation failure blocks dispatch but does not block terminal reconciliation through the
last-known-good workflow. A tracker-fetch failure defers both terminal reconciliation and new
dispatch until the next tick.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- Its adapter-provided `dispatchable` value is `true`.
- It contains every label in `tracker.required_labels`.
- It contains no label in `tracker.excluded_labels`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.

For a version-3 managed deployment, the accepted tracker policy supplies the state and driver-label
parts of these rules. A new WorkSession uses the deployment's current policy; an existing
WorkSession uses its stored policy even after a repin. The issue's live lane MUST be both `active`
and `authoring`, and its labels MUST select exactly the accepted Symphony driver. An active
delivery-only lane is reconciliation work, not dispatch eligibility, and MUST NOT reserve an agent
slot. A lane with delivery operations may be reconciled even when its `active` bit is false. The
adapter's `dispatchable` field remains a provider fact such as whether the issue is open; it MUST
NOT duplicate or override accepted lane meaning.

For refresh and continuation checks, `issue_routable(issue)` means only that adapter-provided
`dispatchable` is true, all `tracker.required_labels` match, and no `tracker.excluded_labels`
match. State, claims, and concurrency are checked separately by the surrounding algorithm.

Sorting order (stable intent):

1. `priority` ascending for values `1..4`; all other integers and null sort after that bucket
2. `created_at` oldest first; null sorts last
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized)
- otherwise fallback to global limit

The runtime counts issues by their current tracked state in the `running` map. The count controls
capacity, while the transactional runtime lease remains the duplicate-execution guard.

### 8.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same issue.
- Transactionally store `kind`, `attempt`, `error`, `due_at`, `recorded_at`, and the optional
  fresh-attempt generation beneath the WorkSession.
- Only after the durable write, install or replace the process timer as a wake-up projection.

Backoff formula:

- Normal continuation retries after a clean worker exit use a short fixed delay of `1000` ms.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Power is capped by the configured max retry backoff (default `300000` / 5m).

Retry handling behavior:

1. Refresh the specific issue with `fetch_issues_by_ids([issue_id])`.
2. If not found, release claim.
3. If found in a terminal state, clean its workspace and release claim.
4. If found and still active and routable:
   - Dispatch if slots are available.
   - Otherwise requeue with error `no available orchestrator slots`.
5. If found but no longer active or routable, release claim without dispatch.

After restart, overdue durable retries run as soon as capacity and tracker eligibility allow;
future retries receive a timer for their remaining delay. Completing, cancelling, or releasing the
WorkSession clears the matching durable retry transactionally. A stale worker must not overwrite a
newer attempt's retry.

Note:

- Terminal-state workspace cleanup is handled by startup cleanup, normal-poll terminal
  reconciliation, active-run reconciliation, and retry refreshes that observe a terminal
  transition.
- ID refresh avoids treating a terminal, non-active, or newly unroutable issue as merely absent.

### 8.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

- For each running issue, compute `elapsed_ms` since:
  - `last_codex_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > codex.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.

Part B: Tracker state refresh

- Fetch current issue states for all running issue IDs.
- For each running issue:
  - If tracker state is terminal: terminate worker and clean workspace.
  - If tracker state is still active and routable: update the in-memory issue snapshot.
  - If tracker state is active but no longer routable: terminate worker without workspace cleanup.
  - If tracker state is neither active nor terminal: terminate worker without workspace cleanup.
- If state refresh fails, keep workers running and try again on the next tick.

### 8.6 Terminal Workspace Reconciliation

When the service starts:

1. Clear the in-memory set of observed terminal issue IDs.
2. Query the tracker for issues in terminal states.
3. For each returned issue, invoke the selected repository driver's cleanup and record its opaque
   issue ID as observed. A managed driver may remove only a workspace named by a matching durable
   lease; absence or ambiguity retains it.
4. If the terminal-issues fetch fails, log a warning and continue startup with an empty observed
   set so a later successful poll can recover.

On every successful normal state-list fetch:

1. Build the complete set of issue IDs currently returned in terminal states.
2. For each terminal issue that was not observed in the preceding successful fetch and has no
   current orchestrator claim, invoke workspace cleanup.
3. Do not clean a claimed terminal issue from this path; its running-worker or retry lifecycle owns
   safe shutdown and cleanup ordering.
4. Replace the observed-terminal set only after the complete state-list fetch succeeds.

The state-list request includes active and terminal states together, so normal terminal
reconciliation does not require a second board scan. Remembering the preceding terminal set avoids
re-running hooks for every historical terminal item on every tick. An inactive item is absent from
that set; if it later becomes terminal after its worker claim was released, the next successful
poll observes a new terminal ID and invokes cleanup. Restart remains a recovery sweep rather than a
normal lifecycle requirement.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

Workspace root:

- `workspace.root` (normalized absolute path)

Per-issue workspace path:

- `<workspace.root>/<workspace_key>`

Workspace persistence:

- Workspaces are reused across runs for the same issue.
- Successful runs do not auto-delete workspaces.

### 9.2 Workspace Creation and Reuse

Input: `issue`, selected RepositoryDriver, pinned managed or trusted compatibility snapshot, and
fenced Attempt authority.

Algorithm summary:

1. Derive `workspace_key` using Section 4.2, including the stable original-identifier hash when
   sanitization changes the identifier.
2. Compute workspace path under workspace root.
3. Delegate provision/inspect/reuse to the selected driver.
4. Record the typed workspace lease on the Attempt before treating the path as usable.
5. Independently assert that the coding-agent `cwd` is the exact authorized workspace path.

Notes:

- `directory` preserves the original create-directory behavior and optional hooks.
- `harness` preserves the repository-owned lifecycle only for compatibility consumers.
- `git-worktree` uses the built-in managed contract in Section 9.3.
- Dependency preparation is a separate PreparationDriver step; it is not a RepositoryDriver hook.

### 9.3 RepositoryDriver and managed Git-worktree contract

Symphony exposes one internal RepositoryDriver port for prepare, fresh-attempt prepare/ready,
before-run/after-run compatibility operations, launch-`cwd` assertion, and guarded removal.
Managed composition selects the driver from the validated operator binding plus accepted product
profile; candidate code cannot select or replace it.

For `workspace.provider: git-worktree`, the driver MUST:

1. Use the binding's independently validated accepted source repository, not candidate input.
2. Verify that its configured `origin` normalizes to `repository.identity`.
3. Resolve `repository.base_ref` to one full immutable commit SHA on the WorkSession's first managed
   allocation. Persist the repository profile, host roots, workspace location, base ref, and base
   SHA as one WorkSession invariant. Every later Attempt in that WorkSession MUST reuse the pinned
   SHA and MUST NOT re-resolve a mutable ref.
4. Derive a collision-safe branch under the binding's branch prefix using WorkSession identity and,
   when present, a digest of the entire fresh-attempt generation.
5. Transactionally record an `allocating` managed workspace lease plus stable worktree-effect
   idempotency key before invoking Git.
6. Invoke the binding's exact Git executable with ambient `GIT_*` authority removed, system/global
   configuration and attributes disabled, replacement objects disabled, hooks and fsmonitor fixed
   off, and recursive submodule behavior fixed off. Refuse any effective repository
   `filter.*.(clean|smudge|process)` command before allocating the workspace. `git worktree add`
   MUST therefore neither execute a product hook/filter nor inherit a caller-selected Git target.
7. After the Git effect, independently verify the registered worktree path, common Git directory,
   exact branch, source repository, base SHA/profile facts, and realpath containment before marking
   the lease `ready`.
8. On restart, reconcile an allocating/provisioned lease with observed Git state. An exactly
   matching completed effect may be adopted into the recorded transition; an unrecorded existing
   directory or ambiguous registration MUST be refused, not claimed.
9. Reuse only a ready lease whose immutable repository/profile/generation facts match. Transfer
   ownership atomically by marking the previous Attempt lease `superseded` while recording the new
   Attempt lease; the aggregate MUST NOT expose two live leases for one path or branch.
10. For cleanup, require the matching WorkSession identity and controller generation with no active
    runtime lease, record `removal_pending`, re-verify lease token, root containment, path, Git
    common directory, registration, branch, and cleanliness, then remove the registered worktree
    and exact branch. A mismatch, dirty tree, symlink, broadened path, or ambiguous Git result
    marks/retains the workspace with an actionable refusal.

The driver MUST NOT fetch from an unapproved remote, choose proof, push, merge, or execute package
manager/build commands. Those concerns belong to their separate owners.

#### 9.3.1 Fresh-attempt extension

When `tracker.fresh_attempt_states` is configured, the implementation MUST derive a filesystem-safe
generation from the opaque issue ID and `state_version` and bind it to durable Attempt/workspace
state outside the agent workspace.

For the managed driver, the same generation reuses the exact ready managed worktree. A changed
generation may replace only the previous managed lease after the guarded removal contract succeeds;
it then allocates a collision-safe new branch/worktree and deletes only the provider's managed Agent
Workpad before marking the generation ready. Restart after the Git effect or workpad deletion MUST
resume from durable lease/outbox state without allocating a second branch or deleting the workpad
twice.

For compatibility `harness` mode only, the existing strict receipt plus `before_remove` reset
protocol remains valid. It is not permitted for a new consumer and does not become authority for a
managed workspace.

If any fresh preflight step cannot be proven, the coding agent MUST NOT start. The tracker adapter
MUST upsert the exact blocker before moving the card to `fresh_attempt_failure_state`. Failure of
that tracker handoff creates a `fresh_handoff` retry which may retry only the handoff. A changed
state version invalidates workers and retries from the earlier generation.

### 9.4 Workspace Hooks

Hooks are a `directory`/`harness` compatibility contract. A managed Git-worktree workflow defines
none; configuration validation MUST refuse such a combination.

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the workspace directory as
  `cwd`.
- On POSIX systems, `sh -lc <script>` (or a stricter equivalent such as `bash -lc <script>`) is a
  conforming default.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.

### 9.5 Safety Invariants

This is the most important portability constraint.

Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching the coding-agent subprocess, validate:
  - `cwd == workspace_path`

Invariant 2: Workspace path MUST stay inside workspace root.

- Normalize both paths to absolute.
- Require `workspace_path` to have `workspace_root` as a prefix directory.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Replace all other characters with `_`.
- If replacement changes the identifier, append a stable original-identifier hash suffix with at
  least 64 bits of entropy so keys remain collision-resistant after sanitization.

Invariant 4: Managed cleanup requires two kinds of agreement.

- Symphony's durable managed lease must name the exact repository, profile digest, source root,
  workspace root/path, branch, and lease token.
- Independent realpath and Git observations must match those facts immediately before mutation.
- Filesystem/Git observation without a lease is never sufficient removal authority.

Invariant 5: Human attachments are outside workspace ownership.

- The interactive extension records `HumanWorkspaceAttachment` only on the WorkSession root; it
  MUST NOT create an Attempt workspace lease.
- RepositoryDriver cleanup and materialization accept only managed/compatibility lease types, so a
  human attachment is mechanically unrepresentable as their target regardless of cleanliness or
  controller request.

## 10. Agent Runner Protocol (Coding Agent Integration)

This section defines Symphony's language-neutral responsibilities when integrating a Codex
app-server. The Codex app-server protocol for the targeted Codex version is the source of truth for
protocol schemas, message payloads, transport framing, and method names.

Protocol source of truth:

- Implementations MUST send messages that are valid for the targeted Codex app-server version.
- Implementations MUST consult the targeted Codex app-server documentation or generated schema
  instead of treating this specification as a protocol schema.
- If this specification appears to conflict with the targeted Codex app-server protocol, the Codex
  protocol controls protocol shape and transport behavior.
- Symphony-specific requirements in this section still control orchestration behavior, workspace
  selection, prompt construction, continuation handling, and observability extraction.

### 10.1 Launch Contract

Subprocess launch parameters:

- Compatibility command: `codex.command`
- Compatibility invocation: `bash -lc <codex.command>`
- Managed invocation: the exact Section 5.0.1 `systemd-run --user --scope ... -- <codex>
app-server` argument vector, with no shell or environment expansion
- Working directory: workspace path
- Transport/framing: the protocol transport required by the targeted Codex app-server version

Notes:

- The compatibility default command is `codex app-server`; a managed binding pins the executable.
- Approval policy, sandbox policy, cwd, prompt input, and OPTIONAL tool declarations are supplied
  using fields supported by the targeted Codex app-server version.

RECOMMENDED additional process settings:

- Max line size: 10 MB (for safe buffering)

### 10.2 Session Startup Responsibilities

Reference: https://developers.openai.com/codex/app-server/

Startup MUST follow the targeted Codex app-server contract. Symphony additionally requires the
client to:

- Start the app-server subprocess in the per-issue workspace and, for managed Git, inside the
  Attempt's deterministic descendant scope.
- Initialize the app-server session using the targeted Codex app-server protocol.
- Create or resume a coding-agent thread according to the targeted protocol.
- Supply the absolute per-issue workspace path as the thread/turn working directory wherever the
  targeted protocol accepts cwd.
- Start the first turn with the rendered issue prompt.
- Start later in-worker continuation turns on the same live thread with continuation guidance rather
  than resending the original issue prompt.
- Supply the implementation's documented approval and sandbox policy using fields supported by the
  targeted protocol.
- Include issue-identifying metadata, such as `<issue.identifier>: <issue.title>`, when the targeted
  protocol supports turn or session titles.
- Advertise implemented client-side tools using the targeted protocol.

Session identifiers:

- Extract `thread_id` from the thread identity returned by the targeted Codex app-server protocol.
- Extract `turn_id` from each turn identity returned by the targeted Codex app-server protocol.
- Emit `session_id = "<thread_id>-<turn_id>"`
- Reuse the same `thread_id` for all continuation turns inside one worker run

### 10.3 Streaming Turn Processing

The client processes app-server updates according to the targeted Codex app-server protocol until
the active turn terminates.

Completion conditions:

- Targeted-protocol turn completion signal -> success
- Targeted-protocol turn failure signal -> failure
- Targeted-protocol turn cancellation signal -> failure
- turn stream silence timeout (`turn_timeout_ms`) -> failure
- subprocess exit -> failure

Continuation processing:

- If the worker decides to continue after a successful turn, it SHOULD start another turn on the same
  live thread using the targeted protocol.
- The app-server subprocess SHOULD remain alive across those continuation turns and be stopped only
  when the worker run is ending.

Transport handling requirements:

- Follow the transport and framing rules of the targeted Codex app-server version.
- For stdio-based transports, keep protocol stream handling separate from diagnostic stderr
  handling unless the targeted protocol specifies otherwise.
- Managed finalization MUST close/interrupt the app server, terminate the complete configured
  systemd scope with bounded TERM/KILL escalation, and observe the scope absent or inactive with an
  empty control group. Failure MUST surface as `runtime_quiescence_refused`, preserve the active
  Attempt lease, and prevent retry/replacement until reconciliation proves quiescence.

### 10.4 Emitted Runtime Events (Upstream to Orchestrator)

The app-server client emits structured events to the orchestrator callback. Each event SHOULD
include:

- `event` (enum/string)
- `timestamp` (UTC timestamp)
- `codex_app_server_pid` (if available)
- OPTIONAL `usage` map (token counts)
- payload fields as needed

Important emitted events include, for example:

- `session_started`
- `startup_failed`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`
- `turn_ended_with_error`
- `turn_input_required`
- `approval_auto_approved`
- `unsupported_tool_call`
- `notification`
- `other_message`
- `malformed`

### 10.5 Approval, Tool Calls, and User Input Policy

Approval, sandbox, and user-input behavior is implementation-defined.

Policy requirements:

- Each implementation MUST document its chosen approval, sandbox, and operator-confirmation
  posture.
- Approval requests and user-input-required events MUST NOT leave a run stalled indefinitely. An
  implementation MAY either satisfy them, surface them to an operator, auto-resolve them, or
  fail the run according to its documented policy.

Example high-trust behavior:

- Auto-approve command execution approvals for the session.
- Auto-approve file-change approvals for the session.
- Treat user-input-required turns as hard failure.

Unsupported dynamic tool calls:

- Supported dynamic tool calls that are explicitly implemented and advertised by the runtime SHOULD
  be handled according to their extension contract.
- If the agent requests a dynamic tool call that is not supported, return a tool failure response
  using the targeted protocol and continue the session.
- This prevents the session from stalling on unsupported tool execution paths.

Optional provider-native agent tool extension:

- An adapter MAY expose provider-native tools to the app-server session.
- The selected adapter's tool specs SHOULD be advertised during session startup using the protocol
  mechanism supported by the targeted Codex app-server version.
- Tool specs, adapter selection, and effective tracker settings MUST be bound to one session
  snapshot. A workflow reload applies to future sessions; it MUST NOT make an in-flight session
  advertise one provider and execute another.
- Tool names, schemas, and result payloads are adapter-owned. Symphony does not standardize a
  lowest-common-denominator CRUD API.
- The runtime MUST execute advertised tool calls host-side with the active adapter configuration and
  MUST NOT require the coding-agent child process to read raw tracker tokens from disk or
  environment.
- The runtime SHOULD pass the current normalized issue to the adapter as internal execution context.
  The adapter MAY use `issue.id` and `issue.native_ref` to preserve provider-specific richness
  without teaching the orchestrator provider semantics.
- Tracker credentials SHOULD NOT be inherited by the coding-agent child process. An adapter that
  resolves credentials from environment variables MUST declare authentication-related environment
  names for removal from local and remote child environments. Implementations SHOULD consult current
  provider and client documentation when identifying credential names and aliases, as these can
  change over time. Literal credentials in a repo-owned `WORKFLOW.md` remain readable to a child
  with workspace access and SHOULD NOT be used when this isolation matters.
- Unsupported tool names MUST return a structured failure result using the targeted protocol and
  continue the session.
- Each adapter that ships tools MUST document:
  - tool names and input schemas;
  - whether a tool can mutate tracker state;
  - scope/authorization behavior;
  - result and error semantics;
  - any provider-side idempotency or rate-limit expectations.

Minimal language-neutral adapter hooks for this OPTIONAL extension:

```text
agent_tool_specs() -> list<ToolSpec>
secret_environment_names() -> list<string>
execute_agent_tool(name, arguments, context={issue}) -> ToolResult
```

`ToolResult` MUST distinguish success from failure and carry JSON-safe structured output that can
be translated to the targeted app-server protocol. The context contains the normalized issue, never
the credential.

User-input-required policy:

- Implementations MUST document how targeted-protocol user-input-required signals are handled.
- A run MUST NOT stall indefinitely waiting for user input.
- A conforming implementation MAY fail the run, surface the request to an operator, satisfy it
  through an approved operator channel, or auto-resolve it according to its documented policy.
- The example high-trust behavior above fails user-input-required turns immediately.

### 10.6 Timeouts and Error Mapping

Timeouts:

- `codex.read_timeout_ms`: request/response timeout during startup and sync requests
- `codex.turn_timeout_ms`: maximum silence interval while a turn stream is active; each
  app-server output resets it, so it is not a total turn runtime cap
- `codex.stall_timeout_ms`: enforced by orchestrator based on event inactivity

Error mapping (RECOMMENDED normalized categories):

- `codex_not_found`
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `port_exit`
- `response_error`
- `turn_failed`
- `turn_cancelled`
- `turn_input_required`

### 10.7 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + app-server client.

Behavior:

1. Receive a fenced WorkSession/Attempt authority from the orchestrator.
2. Ask the selected RepositoryDriver to create/reuse an ordinary workspace or complete the
   configured fresh-attempt preflight.
3. Run the selected PreparationDriver and durably record its outcome.
4. Build prompt from workflow template.
5. Start app-server session only after workspace, preparation, and tracker preflight succeeds.
6. Forward app-server events to the orchestrator with runtime correlation; transport IDs never
   replace Attempt identity.
7. On an ordinary error, fail the worker attempt for normal retry. Return a typed
   `fresh_attempt_refused` error for preflight refusal so the orchestrator performs only the human
   handoff.

Note:

- Workspaces are intentionally preserved after successful runs.

## 11. Issue Tracker Integration Contract

The issue tracker boundary is deliberately small: a portable read kernel for scheduling plus
OPTIONAL provider-native agent tools. Do not add generic comment/state/attachment CRUD merely to
make providers look alike; those operations lose useful provider semantics and are not needed by
the orchestrator.

An adapter used with `fresh_attempt_states` additionally provides driver-only controls to delete
its one managed workpad and to persist a blocker before assigning the configured failure state.
These controls are not generic agent tools and are not exposed to the coding-agent child.

An adapter used for managed delivery additionally provides a typed state-control capability. It
compares provider truth with an expected state version and selects one policy-authorized target
lane. Symphony uses it only for durable lifecycle effects such as delivery-complete → Done; it is
not generic status CRUD and is never exposed to candidate execution.

### 11.1 REQUIRED Adapter Operations

An implementation MUST support these adapter operations:

1. `fetch_issues_by_states(state_names)`
   - Return normalized issues visible in the configured tracker scope and requested state names.
   - The adapter MUST apply provider-side scope selection and pagination.
   - Used with configured active plus terminal states for normal polling and with terminal states
     alone for startup cleanup.
   - When used for candidate polling, include active scoped issues even when
     `dispatchable=false`; the scheduler owns that final filter.
   - The orchestrator applies `required_labels`, `excluded_labels`, `dispatchable`, claims,
     retries, and concurrency after normalization.
   - An empty `state_names` list MUST return an empty result without a provider request.

2. `fetch_issues_by_ids(issue_ids)`
   - Return current normalized issue snapshots for the supplied opaque dispatch IDs.
   - Used for active-run reconciliation and stale-dispatch revalidation.
   - An empty `issue_ids` list MUST return an empty result without a provider request.
   - IDs no longer visible in the configured scope are omitted; the orchestrator treats omission as
     "no longer visible" rather than inventing a synthetic state.

Both operations return either `ok(list<Issue>)` or an adapter error. For portability, an adapter
error SHOULD expose a stable category and human-readable message. An implementation MAY use a
language-native tagged error, exception, tuple, or enum instead of a literal error object when its
adapter profile documents how those public error forms map to category and message. The
orchestrator relies only on success versus failure.

The operations are atomic from the scheduler's perspective after a paging or transport failure. For
these rules, a record is malformed only when the adapter cannot produce the required normalized
fields (`id`, `identifier`, `title`, `state`, and explicit `dispatchable`) or cannot produce a
valid `Issue` after applying the optional-field fallback rules in Section 11.3. Unusable nullable
or best-effort provider metadata MAY normalize to `null`, an empty list, or omitted best-effort
entries; that fallback alone does not make a record malformed.

A state-list call MAY omit an individually malformed provider record because it was never safe to
dispatch, and SHOULD log that omission. An ID-refresh call MUST fail instead of silently omitting a
malformed requested record, because omission is meaningful. A successful
`fetch_issues_by_ids` result is complete for that call. Output order is not significant, input IDs
are treated as a set, and each dispatch ID appears at most once.

The refresh operation returns full normalized snapshots, not only state strings, because label,
assignment, routing, and provider-specific dispatchability can change while a run is active.

### 11.2 Adapter Responsibilities

Each adapter owns:

- construction from the current effective tracker configuration, including active/terminal states;
- endpoint, authentication, transport, timeouts, pagination, and rate-limit handling;
- provider-specific scope selection (project, board, team, repository, query, or equivalent);
- mapping provider payloads into the normalized Issue fields in Section 4.1.1;
- choosing a stable dispatch identity and preserving any distinct underlying IDs in `native_ref`;
- deriving `dispatchable` from provider-specific routing rules;
- preserving provider-native state names while allowing case-insensitive scheduler comparison;
- OPTIONAL provider-native agent tools and their authorization boundary.

The orchestrator MUST NOT inspect provider payloads, assume that `issue.id` is an underlying
ticket ID, or branch on provider-specific blocker, board, transition, or comment semantics.

Each adapter MUST publish a compact profile in implementation documentation, not only code,
containing:

- exact supported `tracker.kind` value;
- exact `tracker.provider` keys, defaults, secret keys/environment names, and validation errors;
- scope selection, pagination behavior, and provider request limits;
- `id` and `native_ref` mapping;
- state, label, priority, timestamp, `dispatchable`, malformed-record, and optional-field
  normalization;
- provider-native tool names/schemas, mutation capability, scope, and result/error behavior if any;
- mapping from public language-native error forms to portable transport/auth/rate-limit error
  categories and human-readable messages.

### 11.3 Normalization Rules

Adapter output MUST satisfy Section 4.1.1. In addition:

- Every listed field MUST be present in the normalized record. Nullable fields use `null`;
  collection fields use an empty list when absent.
- `id`, `identifier`, `title`, and `state` MUST be non-empty strings.
- `labels` MUST be trimmed, lowercased strings; blank labels MUST be dropped and duplicate labels
  SHOULD be removed.
- `priority` MUST be an integer or null.
- The scheduler ranks priorities `1..4` before null/unknown values; other integers sort with
  null/unknown unless an implementation documents a different mapping.
- `created_at` and `updated_at` MUST represent parsed RFC 3339 instants or null; the in-memory
  timestamp type is implementation-defined.
- Unusable provider values for nullable fields MAY normalize to `null`. Unusable best-effort
  collection entries MAY be dropped; if no usable entries remain, use an empty list. These
  fallbacks MUST NOT be used for `id`, `identifier`, `title`, `state`, or explicit
  `dispatchable`.
- Preserve provider spelling in `state`, but trim and lowercase only for scheduler comparisons.
- `blocked_by` is best-effort metadata; adapters MUST NOT invent blocker semantics they cannot
  represent reliably.
- `dispatchable` MUST be explicit. It is `true` only when provider-specific eligibility checks
  pass; the generic scheduler never tries to reconstruct those checks from `native_ref`.
- `native_ref` MUST be null or a JSON-safe object containing only non-secret values safe to expose
  in prompt/tool context. If provider metadata cannot be represented safely, normalize
  `native_ref` to null; otherwise preserve the retained object verbatim.

### 11.4 Error Handling Contract

RECOMMENDED adapter error categories:

- `unsupported_tracker_kind`
- `invalid_tracker_config`
- `missing_tracker_secret`
- `tracker_request` (transport failure)
- `tracker_status` (non-success response)
- `tracker_response` (malformed or semantically invalid payload)
- `tracker_pagination` (pagination integrity failure)
- `tracker_rate_limited`

For portability, every adapter profile MUST document how each public language-native error form
maps to a stable `category` and human-readable `message`. A literal `{category, message}`
object is not required. Adapters MAY add `retryable`, `retry_after_ms`, provider status, and
provider-specific detail, but the orchestrator only relies on success vs. failure.

Orchestrator behavior on tracker errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Startup terminal cleanup failure: log warning and continue startup.

### 11.5 Tracker Writes and Agent Tools (Important Boundary)

Symphony does not require first-class tracker write APIs in the orchestrator.

- Ticket mutations (state transitions, comments, attachments, PR metadata) are typically handled by
  the coding agent through the selected adapter's provider-native tools.
- Tools execute in Symphony with the configured adapter credential; the child receives tool results,
  not a raw token.
- The current normalized issue is available to tool execution as context, including opaque
  `native_ref`, so adapters can retain provider richness without adding it to the core scheduler.
- The service remains a scheduler/runner and tracker reader.
- Workflow-specific success often means "reached the next handoff state" (for example
  `Human Review`) rather than tracker terminal state `Done`.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

Inputs to prompt rendering:

- `workflow.prompt_template`
- normalized `issue` object
- OPTIONAL `attempt` integer (retry/continuation metadata)

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` SHOULD be passed to the template as a 1-based retry/continuation count:

- first run: `attempt` is null or absent;
- any later run: `attempt` is an integer.

The core `attempt` value does not distinguish a normal continuation from an error/timeout/stall
retry. An implementation MAY expose an additional `retry_kind` template field if workflows need
that distinction, but it is not part of core conformance.

### 12.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure and decide retry behavior.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

REQUIRED context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

REQUIRED context for coding-agent session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 13.2 Logging Outputs and Sinks

The spec does not prescribe where logs are written (stderr, file, remote sink, etc.).

Requirements:

- Operators MUST be able to see startup/validation/dispatch failures without attaching a debugger.
- Implementations MAY write to one or more sinks.
- If a configured log sink fails, the service SHOULD continue running when possible and emit an
  operator-visible warning through any remaining sink.

### 13.3 Runtime Snapshot / Monitoring Interface (OPTIONAL but RECOMMENDED)

If the implementation exposes a synchronous runtime snapshot (for dashboards or monitoring), it
SHOULD return:

- `running` (list of running session rows)
- each running row SHOULD include `turn_count`
- `retrying` (list of retry queue rows)
- session and retry rows SHOULD include the tracker-provided issue URL when available
- `codex_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `seconds_running` (aggregate runtime seconds as of snapshot time, including active sessions)
- `rate_limits` (latest coding-agent rate limit payload, if available)

RECOMMENDED snapshot error modes:

- `timeout`
- `unavailable`

### 13.4 Status Surfaces

The manual WorkSession CLI status defined in Section 7.6 is REQUIRED for this implementation and is
projected from durable state. A separate daemon runtime surface (terminal output, dashboard, etc.)
is OPTIONAL and implementation-defined; if present, it SHOULD draw from orchestrator
state/metrics. Neither surface may mutate authority merely by reading or be required for
orchestration correctness.

### 13.5 Session Metrics and Token Accounting

Token accounting rules:

- Agent events can include token counts in multiple payload shapes.
- Prefer absolute thread totals when available, such as:
  - `thread/tokenUsage/updated` payloads
  - `total_token_usage` within token-count wrapper events
- Ignore delta-style payloads such as `last_token_usage` for dashboard/API totals.
- Extract input/output/total token counts leniently from common field names within the selected
  payload.
- For absolute totals, track deltas relative to last reported totals to avoid double-counting.
- Do not treat generic `usage` maps as cumulative totals unless the event type defines them that
  way.
- Accumulate aggregate totals in orchestrator state.

Runtime accounting:

- Runtime SHOULD be reported as a live aggregate at snapshot/render time.
- Implementations MAY maintain a cumulative counter for ended sessions and add active-session
  elapsed time derived from `running` entries (for example `started_at`) when producing a
  snapshot/status view.
- Add run duration seconds to the cumulative ended-session runtime when a session ends (normal exit
  or cancellation/termination).
- Continuous background ticking of runtime totals is not REQUIRED.

Rate-limit tracking:

- Track the latest rate-limit payload seen in any agent update.
- Any human-readable presentation of rate-limit data is implementation-defined.

### 13.6 Humanized Agent Event Summaries (OPTIONAL)

Humanized summaries of raw agent protocol events are OPTIONAL.

If implemented:

- Treat them as observability-only output.
- Do not make orchestrator logic depend on humanized strings.

### 13.7 OPTIONAL HTTP Server Extension

This section defines an OPTIONAL HTTP interface for observability and operational control.

If implemented:

- The HTTP server is an extension and is not REQUIRED for conformance.
- The implementation MAY serve server-rendered HTML or a client-side application for the dashboard.
- The dashboard/API MUST be observability/control surfaces only and MUST NOT become REQUIRED for
  orchestrator correctness.

Extension config:

- `server.port` (integer, OPTIONAL)
  - Enables the HTTP server extension.
  - `0` requests an ephemeral port for local development and tests.
  - CLI `--port` overrides `server.port` when both are present.

Enablement (extension):

- Start the HTTP server when a CLI `--port` argument is provided.
- Start the HTTP server when `server.port` is present in `WORKFLOW.md` front matter.
- The `server` top-level key is owned by this extension.
- Positive `server.port` values bind that port.
- Implementations SHOULD bind loopback by default (`127.0.0.1` or host equivalent) unless explicitly
  configured otherwise.
- Changes to HTTP listener settings (for example `server.port`) do not need to hot-rebind;
  restart-required behavior is conformant.

#### 13.7.1 Human-Readable Dashboard (`/`)

- Host a human-readable dashboard at `/`.
- The returned document SHOULD depict the current state of the system (for example active sessions,
  retry delays, token consumption, runtime totals, recent events, and health/error indicators).
- It is up to the implementation whether this is server-generated HTML or a client-side app that
  consumes the JSON API below.

#### 13.7.2 JSON REST API (`/api/v1/*`)

Provide a JSON REST API under `/api/v1/*` for current runtime state and operational debugging.

Minimum endpoints:

- `GET /api/v1/state`
  - Returns a summary view of the current system state (running sessions, retry queue/delays,
    aggregate token/runtime totals, latest rate limits, and any additional tracked summary fields).
  - Suggested response shape:

    ```json
    {
      "generated_at": "2026-02-24T20:15:30Z",
      "counts": {
        "running": 2,
        "retrying": 1
      },
      "running": [
        {
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "issue_url": "https://tracker.example/issues/MT-649",
          "state": "In Progress",
          "session_id": "thread-1-turn-1",
          "turn_count": 7,
          "last_event": "turn_completed",
          "last_message": "",
          "started_at": "2026-02-24T20:10:12Z",
          "last_event_at": "2026-02-24T20:14:59Z",
          "tokens": {
            "input_tokens": 1200,
            "output_tokens": 800,
            "total_tokens": 2000
          }
        }
      ],
      "retrying": [
        {
          "issue_id": "def456",
          "issue_identifier": "MT-650",
          "issue_url": "https://tracker.example/issues/MT-650",
          "attempt": 3,
          "due_at": "2026-02-24T20:16:00Z",
          "error": "no available orchestrator slots"
        }
      ],
      "codex_totals": {
        "input_tokens": 5000,
        "output_tokens": 2400,
        "total_tokens": 7400,
        "seconds_running": 1834.2
      },
      "rate_limits": null
    }
    ```

- `GET /api/v1/<issue_identifier>`
  - Returns issue-specific runtime/debug details for the identified issue, including any information
    the implementation tracks that is useful for debugging.
  - Suggested response shape:

    ```json
    {
      "issue_identifier": "MT-649",
      "issue_id": "abc123",
      "status": "running",
      "workspace": {
        "path": "/tmp/symphony_workspaces/MT-649"
      },
      "attempts": {
        "restart_count": 1,
        "current_retry_attempt": 2
      },
      "running": {
        "session_id": "thread-1-turn-1",
        "turn_count": 7,
        "state": "In Progress",
        "started_at": "2026-02-24T20:10:12Z",
        "last_event": "notification",
        "last_message": "Working on tests",
        "last_event_at": "2026-02-24T20:14:59Z",
        "tokens": {
          "input_tokens": 1200,
          "output_tokens": 800,
          "total_tokens": 2000
        }
      },
      "retry": null,
      "logs": {
        "codex_session_logs": [
          {
            "label": "latest",
            "path": "/var/log/symphony/codex/MT-649/latest.log",
            "url": null
          }
        ]
      },
      "recent_events": [
        {
          "at": "2026-02-24T20:14:59Z",
          "event": "notification",
          "message": "Working on tests"
        }
      ],
      "last_error": null,
      "tracked": {}
    }
    ```

  - If the issue is unknown to the current in-memory state, return `404` with an error response (for
    example `{\"error\":{\"code\":\"issue_not_found\",\"message\":\"...\"}}`).

- `POST /api/v1/refresh`
  - Queues an immediate tracker poll + reconciliation cycle (best-effort trigger; implementations
    MAY coalesce repeated requests).
  - Suggested request body: empty body or `{}`.
  - Suggested response (`202 Accepted`) shape:

    ```json
    {
      "queued": true,
      "coalesced": false,
      "requested_at": "2026-02-24T20:15:30Z",
      "operations": ["poll", "reconcile"]
    }
    ```

API design notes:

- The JSON shapes above are the RECOMMENDED baseline for interoperability and debugging ergonomics.
- Implementations MAY add fields, but SHOULD avoid breaking existing fields within a version.
- Endpoints SHOULD be read-only except for operational triggers like `/refresh`.
- Unsupported methods on defined routes SHOULD return `405 Method Not Allowed`.
- API errors SHOULD use a JSON envelope such as `{"error":{"code":"...","message":"..."}}`.
- If the dashboard is a client-side app, it SHOULD consume this API rather than duplicating state
  logic.

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `WORKFLOW.md`
   - Invalid YAML front matter
   - Unsupported tracker kind or invalid adapter-owned tracker configuration
   - Missing coding-agent executable

2. `Workspace Failures`
   - Workspace directory creation failure
   - Managed Git identity, allocation, recovery, or cleanup refusal
   - Compatibility hook population/synchronization failure
   - Invalid workspace path configuration
   - Hook timeout/failure

3. `State Store Failures`
   - Database path/type/permission refusal
   - Migration or integrity-check failure
   - Busy/transaction failure
   - Stale revision, controller generation, runtime lease, workspace lease, or effect conflict

4. `Preparation Failures`
   - Missing or linked manifest/lockfile
   - Missing sandbox or package-manager executable
   - Frozen install failure, timeout, cancellation, or cleanup refusal

5. `Agent Session Failures`
   - Startup handshake failure
   - Turn failed/cancelled
   - Turn timeout
   - User input requested and handled as failure by the implementation's documented policy
   - Subprocess exit
   - Stalled session (no activity)

6. `Tracker Failures`
   - Provider transport errors
   - Non-success provider responses
   - Provider-reported application errors
   - Malformed payloads

7. `Observability Failures`
   - Snapshot timeout
   - Dashboard render errors
   - Log sink configuration failure

### 14.2 Recovery Behavior

- Dispatch validation failures:
  - Skip new dispatches.
  - Keep service alive.
  - Continue reconciliation where possible.

- Worker failures:
  - Convert to retries with exponential backoff.

- State integrity/migration failures:
  - Refuse startup or the affected mutation; do not fall back to tracker/comments/filesystem as a
    replacement state writer.

- Managed-workspace ambiguity:
  - Retain the workspace and record/log an actionable refusal; do not broaden cleanup.

- Preparation setup refusal/failure:
  - Record its four-way status before failing the attempt; never retry outside the configured
    sandbox as a fallback.

- Tracker candidate-fetch failures:
  - Skip this tick.
  - Try again on next tick.

- Reconciliation state-refresh failures:
  - Keep current workers.
  - Retry on next tick.

- Dashboard/log failures:
  - Do not crash the orchestrator.

### 14.3 Partial State Recovery (Restart)

WorkSession state is durable. Process-local workers, Codex processes, and timer handles are not.
Restart recovery means the service resumes or safely refuses from the state-store records and then
reconciles external facts with their semantic owners.

After restart:

- Expired active runtime leases are listed as reconciliation candidates. Managed descendants are
  terminated and proven absent before the exact attempt/token/generation is marked
  expired/interrupted and permanently fenced. Failure retains the active lease and blocks a new
  Attempt.
- Durable retry intents remain visible to normal polling and cannot be admitted before their
  recorded due times; overdue intents are considered on the first eligible poll.
- No Codex process/thread is assumed recoverable merely because its correlation ID was recorded.
- Pending external-effect intents are reconciled by stable idempotency key and independent provider
  observation before retry or completion.
- Managed worktree leases are checked against Git/filesystem truth. An exact recorded effect may be
  completed; missing or ambiguous authority retains/refuses.
- Tracker polling refreshes authorization and terminal facts; it cannot invent a WorkSession lease.

### 14.4 Operator Intervention Points

Operators can control behavior by:

- Replacing an operator-owned managed binding and restarting cleanly to accept a new product
  revision or host topology.
- Editing compatibility `WORKFLOW.md`; those changes are detected and re-applied automatically
  without restart according to Section 6.2.
- Changing issue states in the tracker:
  - terminal state -> running session is stopped and workspace cleaned when reconciled
  - non-active state -> running session is stopped without cleanup
- Restarting the service for process recovery, deployment, or an operator-requested retry of a
  retained terminal workspace after its guarded teardown has been repaired. Restart is not the
  normal path for observing a terminal transition. It is required for managed binding/profile
  changes but not for compatibility workflow edits.

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Each implementation defines its own trust boundary.

Operational safety requirements:

- Implementations SHOULD state clearly whether they are intended for trusted environments, more
  restrictive environments, or both.
- Implementations SHOULD state clearly whether they rely on auto-approved actions, operator
  approvals, stricter sandboxing, or some combination of those controls.
- Workspace isolation and path validation are important baseline controls, but they are not a
  substitute for whatever approval and sandbox policy an implementation chooses.

### 15.2 Filesystem Safety Requirements

Mandatory:

- Workspace path MUST remain under configured workspace root.
- Coding-agent cwd MUST be the per-issue workspace path for the current run.
- Workspace directory names MUST use sanitized identifiers.
- The state database and preparation caches MUST remain outside candidate worktree paths and be
  private to the service identity.
- State/database/cache paths MUST refuse symlinks and unexpected entry types before use or removal.
- Managed removal MUST require a matching durable lease plus independent Git/filesystem identity.

RECOMMENDED additional hardening for ports:

- Run under a dedicated OS user.
- Restrict workspace root permissions.
- Mount workspace root on a dedicated volume if possible.

### 15.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens or secret env values.
- Validate presence of secrets without printing them.
- Execute provider-native tracker tools in the Symphony host process with the configured adapter
  credential.
- Do not pass tracker credentials through the coding-agent child environment. Adapters MUST declare
  secret environment names so local and remote launchers can remove them from child environments.
- Do not place literal tracker credentials in a repo-owned `WORKFLOW.md` when the child can read
  that workspace; use host-side secret references instead.

### 15.4 Hook Script Safety

Workspace hooks are arbitrary shell scripts from `WORKFLOW.md` and exist only on compatibility
drivers. Managed Git-worktree workflows MUST reject them.

Implications:

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory.
- Hook output SHOULD be truncated in logs.
- Hook timeouts are REQUIRED to avoid hanging the orchestrator.

### 15.4.1 Managed Git process safety

Managed repository lifecycle MUST use the operator binding's exact Git executable. Every invocation
MUST drop ambient `GIT_*` variables, global/system config and attributes, replacement objects,
interactive prompts, hooks, fsmonitor, and recursive submodules. Effective repository clean,
smudge, and long-running filter commands are unsupported and MUST be detected before workspace
allocation. A refusal creates no managed-workspace directory and executes no product-controlled
hook or filter.

### 15.5 Managed preparation safety

The pnpm preparation subprocess executes repository-derived package metadata, even with lifecycle
scripts disabled, so it is a distinct hostile-execution boundary.

- It MUST fail closed when the configured sandbox cannot start.
- It MUST inherit an explicit environment allowlist, not the Symphony parent environment.
- It MUST NOT see tracker, Git hosting, WCP, delivery, SSH, home-directory, sibling-repository,
  Symphony-state, or host-control credentials/paths.
- It MUST mount only the managed worktree, its attempt-private cache, required read-only
  toolchain/system roots, the operator-pinned read-only dependency seed, and ephemeral `/tmp`,
  `/proc`, and `/dev` surfaces.
- It MUST use a new network namespace with no host/private/metadata route. The first pnpm class is
  offline-only; a missing seed object is a refusal/failure, never authority to enable host network.
- It MUST validate every package source and SHA-512 integrity plus all package-manager control
  inputs before execution, record the dependency-policy identity/digest, and reject input or policy
  drift on a previously bound Attempt.
- It MUST use frozen lockfile semantics, disable lifecycle scripts, pnpm hooks, and runtime
  downloads, verify store integrity, and copy packages out of read-only seed bytes.
- Cancellation and timeout MUST terminate detached descendants before terminal preparation state
  is recorded.
- Output recorded in state/logs MUST be bounded and secret-redacted.

### 15.6 Harness Hardening Guidance

Running Codex agents against repositories, issue trackers, and other inputs that can contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or full machine compromise if the agent is induced to execute
harmful commands or use overly-powerful integrations.

Implementations SHOULD explicitly evaluate their own risk profile and harden the execution harness
where appropriate. This specification intentionally does not mandate a single hardening posture, but
implementations SHOULD NOT assume that tracker data, repository contents, prompt inputs, or tool
arguments are fully trustworthy just because they originate inside a normal workflow.

Possible hardening measures include:

- Tightening Codex approval and sandbox settings described elsewhere in this specification instead
  of running with a maximally permissive configuration.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials beyond the built-in Codex policy controls.
- Filtering which issues, projects, boards, teams, labels, or other tracker sources are eligible
  for dispatch so untrusted or out-of-scope tasks do not automatically reach the agent.
- Narrowing provider-native tools so they can only read or mutate data inside the intended tracker
  scope, rather than exposing general workspace-wide tracker access.
- Reducing the set of client-side tools, credentials, filesystem paths, and network destinations
  available to the agent to the minimum needed for the workflow.

The correct controls are deployment-specific, but implementations SHOULD document them clearly and
treat harness hardening as part of the core safety model rather than an optional afterthought.

## 16. Reference Algorithms (Language-Agnostic)

### 16.1 Service Startup

```text
function start_service():
  configure_logging()

  source = resolve_cli_source()
  if source is managed_binding:
    workflow_snapshot = resolve_exact_governance_profile_context_and_binding(source)
  else:
    workflow_snapshot = load_compatibility_workflow(source)
    if workflow_snapshot.workspace_provider is managed_git:
      fail_startup("managed Git requires deployment binding")

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  if workspace_provider is managed_git:
    require_non_null_accepted_governance_for_new_attempts()
    validate_governance_source_origin_base_executables_and_roots_read_only()
    if governance, source, state, and workspace roots are not pairwise disjoint:
      fail_startup_without_creating_state_or_workspace_paths()

  state_store = open_and_validate_state_store(selected_state_database_path())
  for lease in state_store.list_expired_runtime_leases(now_utc()):
    if agent_runtime.prove_quiescent(lease.work_session_id, lease.controller_generation):
      state_store.expire_runtime_lease(lease, now_utc())

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    observed_terminal_issue_ids: set(),
    completed: set(),
    codex_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    codex_rate_limits: null
  }

  make_durable_retries_visible_to_polling(state_store, state)
  make_pending_deliveries_visible_to_polling(state_store, state)
  startup_terminal_workspace_cleanup()
  make_pending_effects_visible_to_owning_reconciliation(state_store)
  start_observability_outputs()
  if source is compatibility_workflow:
    start_workflow_watch(on_change=reload_and_reapply_workflow)
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)

  for lease in state_store.list_expired_runtime_leases(now_utc()):
    if not agent_runtime.prove_quiescent(lease.work_session_id, lease.controller_generation):
      log_error("retain lease; quiescence unproven")
      schedule_tick(state.poll_interval_ms)
      return state
    state_store.expire_runtime_lease(lease, now_utc())

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)

  states = reconciliation_states(current_policy + active_session_policies)
  issues = tracker.fetch_issues_by_states(states)
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  reconcile_deliveries_without_agent_slots(issues, state_store)

  current_terminal_ids = set()
  for issue in issues:
    if not pinned_policy_for(issue).lane(issue.state).terminal:
      continue
    current_terminal_ids.add(issue.id)
    if issue.id not in state.observed_terminal_issue_ids and issue.id not in state.claimed and not delivery_pending(issue):
      cleanup_issue_workspace(issue)
  state.observed_terminal_issue_ids = current_terminal_ids

  if validation is not ok:
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break

    if pinned_policy_for(issue).allows_authoring(issue) and should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 Reconcile Active Runs

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)

  running_ids = keys(state.running)
  if running_ids is empty:
    return state

  refreshed = tracker.fetch_issues_by_ids(running_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    policy = state_store.get_session(issue).accepted_tracker_policy
    if policy.lane(issue.state).terminal:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=true)
    else if policy.allows_authoring(issue) and issue_routable(issue):
      state.running[issue.id].issue = issue
    else:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=false)

  returned_ids = set(issue.id for issue in refreshed)
  for missing_id in running_ids - returned_ids:
    state = terminate_running_issue(state, missing_id, cleanup_workspace=false)

  return state
```

### 16.4 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  work_session = state_store.get_or_create_tracker_session(
    tracker_kind,
    repository_identity,
    issue,
    pinned_doctrine_snapshot,
    pinned_governance_manifest,
    complete_typed_tracker_policy,
    pinned_product_configuration
  )

  if not work_session.accepted_tracker_policy.allows_authoring(issue):
    return state

  authority = state_store.start_attempt(
    work_session.id,
    controller_generation=work_session.controller.generation,
    holder_id=daemon_instance_id,
    tracker_attempt=attempt,
    lease_expires_at=now_utc() + runtime_lease_duration
  )
  if authority refused because another lease is active:
    return state

  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, authority, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    state_store.finish_attempt(authority, status="failed", error="failed to spawn agent")
    return schedule_retry_durably(state, work_session.id, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  state.running[issue.id] = {
    worker_handle,
    monitor_handle,
    identifier: issue.identifier,
    issue,
    work_session_id: work_session.id,
    attempt_id: authority.attempt_id,
    runtime_lease_token: authority.runtime_lease_token,
    controller_generation: authority.controller_generation,
    session_id: null,
    codex_app_server_pid: null,
    last_codex_message: null,
    last_codex_event: null,
    last_codex_timestamp: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
  return state
```

### 16.5 Worker Attempt (Workspace + Prompt + Agent)

```text
function run_agent_attempt(issue, attempt, authority, orchestrator_channel):
  workspace = repository_driver.prepare(issue, workflow_snapshot, authority)
  if workspace failed:
    fail_worker("workspace error")

  prepared = preparation_driver.prepare(issue, workspace, workflow_snapshot, authority)
  if prepared failed or refused:
    fail_worker("preparation error")

  repository_driver.before_run(issue, workspace, workflow_snapshot, authority)
  repository_driver.assert_agent_launch_cwd(workspace, workspace.path)

  managed_runtime = agent_runtime.open(workspace, authority)
  session = app_server.start_session(
    workspace=workspace.path,
    command=managed_runtime.command,
    environment=managed_runtime.environment,
    sandbox_policy=managed_runtime.sandbox_policy
  )
  if session failed:
    repository_driver.after_run_best_effort(issue, workspace, authority, "failed")
    fail_worker("agent session startup error")

  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    prompt = build_turn_prompt(workflow_template, issue, attempt, turn_number, max_turns)
    if prompt failed:
      app_server.stop_session(session)
      repository_driver.after_run_best_effort(issue, workspace, authority, "failed")
      fail_worker("prompt error")

    turn_result = app_server.run_turn(
      session=session,
      prompt=prompt,
      issue=issue,
      on_message=(msg) -> send(orchestrator_channel, {codex_update, issue.id, msg})
    )

    if turn_result failed:
      app_server.stop_session(session)
      repository_driver.after_run_best_effort(issue, workspace, authority, "failed")
      fail_worker("agent turn error")

    refreshed_issue = tracker.fetch_issues_by_ids([issue.id])
    if refreshed_issue failed:
      app_server.stop_session(session)
      repository_driver.after_run_best_effort(issue, workspace, authority, "failed")
      fail_worker("issue state refresh error")

    if refreshed_issue is empty:
      break

    issue = refreshed_issue[0]

    if issue.state is not active or not issue_routable(issue):
      break

    if turn_number >= max_turns:
      break

    turn_number = turn_number + 1

  app_server.stop_session(session)
  if managed_runtime.prove_quiescent() failed:
    repository_driver.after_run_best_effort(issue, workspace, authority, "failed")
    fail_worker("runtime_quiescence_refused")
  managed_runtime.cleanup_private_state()
  repository_driver.after_run_best_effort(issue, workspace, authority, "succeeded")

  exit_normal()
```

### 16.6 Worker Exit and Retry Handling

```text
on_worker_exit(issue_id, reason, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == runtime_quiescence_refused:
    log_error("retain active Attempt and runtime lease")
    state.claimed.remove(issue_id)
    notify_observers()
    return state

  state_store.finish_attempt(
    work_session_id=running_entry.work_session_id,
    attempt_id=running_entry.attempt_id,
    runtime_lease_token=running_entry.runtime_lease_token,
    controller_generation=running_entry.controller_generation,
    status=normalize_attempt_outcome(reason)
  )

  if reason == normal:
    state.completed.add(issue_id)  # bookkeeping only
    state = schedule_retry_durably(state, running_entry.work_session_id, issue_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else:
    state = schedule_retry_durably(
      state,
      running_entry.work_session_id,
      issue_id,
      next_attempt_from(running_entry),
      {
        identifier: running_entry.identifier,
        error: format("worker exited: %reason")
      }
    )

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing:
    return state

  refreshed = tracker.fetch_issues_by_ids([issue_id])
  if fetch failed:
    return schedule_retry_durably(
      state,
      retry_entry.work_session_id,
      issue_id,
      retry_entry.attempt + 1,
      {
      identifier: retry_entry.identifier,
      error: "retry refresh failed"
      }
    )

  issue = find_by_id(refreshed, issue_id)
  if issue is null:
    state.claimed.remove(issue_id)
    return state

  if not retry_dispatch_allowed(issue, state, ignore_existing_claim=issue_id):
    state.claimed.remove(issue_id)
    return state

  if no_available_slots(state):
    return schedule_retry_durably(
      state,
      retry_entry.work_session_id,
      issue_id,
      retry_entry.attempt + 1,
      {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
      }
    )

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

## 17. Test and Validation Matrix

A conforming implementation SHOULD include tests that cover the behaviors defined in this
specification.

Validation profiles:

- `Core Conformance`: deterministic tests REQUIRED for all conforming implementations.
- `Extension Conformance`: REQUIRED only for OPTIONAL features that an implementation chooses to
  ship.
- `Real Integration Profile`: environment-dependent smoke/integration checks RECOMMENDED before
  production use.

Unless otherwise noted, Sections 17.1 through 17.7 are `Core Conformance`. Bullets that begin with
`If ... is implemented` are `Extension Conformance`.

### 17.1 Workflow and Config Parsing

- Workflow file path precedence:
  - explicit runtime path is used when provided
  - cwd default is `WORKFLOW.md` when no explicit runtime path is provided
- Workflow file changes are detected and trigger re-read/re-apply without restart
- Invalid workflow reload keeps last known good effective configuration and emits an
  operator-visible error
- Missing `WORKFLOW.md` returns typed error
- Invalid YAML front matter returns typed error
- Front matter non-map returns typed error
- Config defaults apply when OPTIONAL values are missing
- `tracker.kind` validation enforces an implementation-supported adapter
- `tracker.provider` preserves adapter-owned keys and validates them through the selected adapter
- `$VAR` resolution works for documented adapter secret keys and path values
- `~` path expansion works
- `codex.command` is preserved as a shell command string
- Per-state concurrency override map normalizes state names and ignores invalid values
- Managed repository config validates identity, full base ref, safe branch prefix, tracker-scope
  identity match, and absence of lifecycle hooks
- Pnpm preparation config accepts only frozen lockfile plus disabled lifecycle scripts and requires
  the managed Git-worktree provider
- Prompt template renders `issue` and `attempt`
- Prompt rendering fails on unknown variables (strict mode)

### 17.2 State, Repository, Preparation, and Workspace Safety

- State database creation uses a private real directory/file and refuses symlink/unexpected types
- Schema migration and integrity checks are transactional and fail closed on corruption
- One tracker origin creates/reuses one WorkSession; attempts receive stable child identities
- The v1→v2 migration moves only stopped attached checkouts to session-level human attachments and
  rolls back rather than reclassifying an active attached Attempt
- Accepted profile/context/binding inputs pin once; concurrent controller edits use the expected
  WorkSession revision
- Human attachment creates no Attempt/lease, conflicts across active sessions, and blocks Attempt
  admission
- Two processes racing to start an attempt produce exactly one active runtime lease
- Expired runtime tokens and stale controller generations cannot mutate attempt/workspace state
- Durable retry intent survives reopen and restores its due-time behavior
- External-effect idempotency keys reuse the same intent and refuse conflicting payloads
- Backup creates a private non-overwriting database copy that reopens with equivalent state

- Deterministic workspace path per issue identifier
- Missing workspace directory is created
- Existing workspace directory is reused
- Existing non-directory path at workspace location is handled safely (replace or fail per
  implementation policy)
- OPTIONAL workspace population/synchronization errors are surfaced
- `after_create` hook runs only on new workspace creation
- `before_run` hook runs before each attempt and failure/timeouts abort the current attempt
- `after_run` hook runs after each attempt and failure/timeouts are logged and ignored
- `before_remove` hook runs on cleanup and failures/timeouts are ignored
- Workspace path sanitization, stable original-identifier-hash collision resistance, and root
  containment invariants are enforced before agent launch
- Identifiers unchanged by sanitization keep their deterministic workspace key; conformance tests
  include distinct identifiers that sanitize to the same text and verify distinct keys
- Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths
- If the managed Git-worktree driver is implemented:
  - allocation is recorded before Git mutation and a crash after `git worktree add` recovers the
    same worktree rather than creating another
  - origin identity, full base SHA, collision-safe branch, Git common directory, registration, and
    realpath containment are verified independently
  - the same fresh generation reuses its worktree; a changed generation replaces only the proven
    prior managed lease
  - unrecorded directories, dirty worktrees, symlinks, branch/path/common-dir mismatch, and
    ambiguous removal are retained with refusal
- If pnpm preparation is implemented:
  - root/workspace manifests and lockfile/config inputs are regular in-workspace files whose
    individual and complete-set digests are recorded
  - custom URL/Git/SSH/file/workspace sources, arbitrary tarballs, pnpm hooks/config, missing
    SHA-512 integrity, and dependency-policy drift are refused
  - the exact command is offline, frozen, script/hook/runtime-download-disabled, and lifecycle
    marker fixtures do not execute
  - the sandbox sees only its worktree/private cache/minimum toolchain/read-only seed, receives a
    small environment, and cannot read a planted sibling/home/state secret or mutate seed bytes
  - host localhost, private, link-local, and metadata endpoints are unreachable
  - missing/refusing sandbox or seed has no unsandboxed or shared-network fallback
  - cancellation/timeout remove detached descendants before return; status survives restart and
    cleanup removes only the exact private cache subtree

### 17.3 Issue Tracker Adapter

- Poll state-list fetch applies configured active/terminal states and adapter-owned scope selection
- Empty `fetch_issues_by_states([])` returns empty without a provider call
- Empty `fetch_issues_by_ids([])` returns empty without a provider call
- Pagination preserves order across multiple pages
- Labels are normalized to lowercase
- Unusable optional provider metadata normalizes to null/empty without hiding valid required fields
- State-list reads log omitted malformed required records; ID refresh fails malformed requested
  records instead of treating them as invisible
- Refresh by opaque dispatch ID returns full normalized issue snapshots
- A distinct provider ticket ID or project-item ID is preserved in `native_ref` when needed
- Provider-specific routing/blocker/assignment rules become explicit `dispatchable`
- The adapter publishes the required compact profile for config, scope, normalization, tools, and
  portable error mapping
- Error mapping covers config, request, non-success response, malformed payload, pagination, and
  rate limiting, including documented category/message mappings for language-native errors

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time
- `dispatchable=false` issues are not eligible
- Required-label filtering is case-insensitive and applies after adapter normalization
- Active-state issue refresh updates running entry state
- Non-active state stops running agent without workspace cleanup
- Terminal state stops running agent and cleans workspace
- Reconciliation with no running issues is a no-op
- A card that becomes terminal after its inactive continuation released the claim is cleaned on a
  later normal poll without daemon restart
- Normal terminal reconciliation skips claimed issues until their worker/retry lifecycle owns
  cleanup
- Normal worker exit schedules a short continuation retry (attempt 1)
- Abnormal worker exit increments retries with 10s-based exponential backoff
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`
- Retry queue entries durably include kind, attempt, due/recorded times, error, and fresh generation
- Restart restores future/overdue retry behavior without a second active runtime lease
- Stall detection kills stalled sessions and schedules retry
- Slot exhaustion requeues retries with explicit error reason
- If a snapshot API is implemented, it returns running rows, retry rows, token totals, and rate
  limits
- If a snapshot API is implemented, timeout/unavailable cases are surfaced

### 17.5 Coding-Agent App-Server Client

- Launch command uses workspace cwd and invokes `bash -lc <codex.command>`
- Session startup follows the targeted Codex app-server protocol.
- Client identity/capability payloads are valid when the targeted Codex app-server protocol requires
  them.
- Policy-related startup payloads use the implementation's documented approval/sandbox settings
- Thread and turn identities exposed by the targeted protocol are extracted and used to emit
  `session_started`
- Request/response read timeout is enforced
- Turn timeout is enforced
- Transport framing required by the targeted protocol is handled correctly
- For stdio-based transports, diagnostic stderr handling is kept separate from the protocol stream
- Command/file-change approvals are handled according to the implementation's documented policy
- Unsupported dynamic tool calls are rejected without stalling the session
- User input requests are handled according to the implementation's documented policy and do not
  stall indefinitely
- Usage and rate-limit telemetry exposed by the targeted protocol is extracted
- Approval, user-input-required, usage, and rate-limit signals are interpreted according to the
  targeted protocol
- If client-side tools are implemented, session startup advertises the supported tool specs
  using the targeted app-server protocol
- If provider-native agent tools are implemented:
  - only the selected adapter's tools are advertised to the session
  - valid inputs execute host-side with configured adapter auth
  - the current normalized issue and `native_ref` are available as internal tool context
  - tracker secrets are not inherited by the coding-agent child process
  - invalid arguments, missing auth, and transport failures return structured failure payloads
  - unsupported tool names still fail without stalling the session

### 17.6 Observability

- Validation failures are operator-visible
- Structured logging includes issue/session context fields
- Logging sink failures do not crash orchestration
- Token/rate-limit aggregation remains correct across repeated agent updates
- If a human-readable status surface is implemented, it is driven from orchestrator state and does
  not affect correctness
- If humanized event summaries are implemented, they cover key wrapper/agent event classes without
  changing orchestrator behavior

### 17.7 CLI and Host Lifecycle

- CLI accepts `--binding path-to-deployment-binding.json` for managed Git and refuses combining it
  with a positional workflow
- CLI exposes `work start|attach|plan|steer|status` exactly as Section 7.6 defines, requires the
  same explicit absolute `--binding` on every invocation, and never constructs the daemon for a
  manual command
- manual writes use expected revisions and the local human controller; `status --json` returns the
  versioned bounded projection and no authority token
- manual start/attach/plan/steer/status survive independent process exit and state-store reopen;
  attachment inspection is read-only and creates no Attempt or lease
- managed Git refuses positional/default `WORKFLOW.md` authority
- CLI accepts a positional workflow path argument (`path-to-WORKFLOW.md`)
- CLI uses `./WORKFLOW.md` when no source is provided, for compatibility only
- CLI errors on nonexistent explicit workflow path or missing default `./WORKFLOW.md`
- CLI surfaces startup failure cleanly
- CLI opens the state store before orchestration, closes it on shutdown, and refuses an unsafe or
  corrupt database path
- CLI exits with success when application starts and shuts down normally
- CLI exits nonzero when startup fails or the host process exits abnormally
- managed shutdown/recovery proves the deterministic descendant scope empty before a runtime lease
  is released or expired
- trusted source materialization records the complete bounded input and advances only the fenced
  managed branch from its expected old SHA
- restart-safe delivery binds every remote mutation and protected proof to the immutable head,
  pinned product-owner grant, current tracker authority, and durable effect intent

### 17.8 Real Integration Profile (RECOMMENDED)

These checks are RECOMMENDED for production readiness and MAY be skipped in CI when credentials,
network access, or external service permissions are unavailable.

- A real tracker smoke test can be run with valid credentials supplied through the selected
  adapter's documented secret mechanism.
- A managed-worktree smoke test correlates one WorkSession/Attempt/lease with the exact source root,
  base SHA, branch, worktree path, preparation record, and terminal cleanup result.
- Real integration tests SHOULD use isolated test identifiers/workspaces and clean up tracker
  artifacts when practical.
- A skipped real-integration test SHOULD be reported as skipped, not silently treated as passed.
- If a real-integration profile is explicitly enabled in CI or release validation, failures SHOULD
  fail that job.

## 18. Implementation Checklist (Definition of Done)

Use the same validation profiles as Section 17:

- Section 18.1 = `Core Conformance`
- Section 18.2 = `Extension Conformance`
- Section 18.3 = `Real Integration Profile`

### 18.1 REQUIRED for Conformance

- Managed source selection supports an exact operator binding; compatibility path selection
  supports an explicit workflow and cwd default
- Strict repository-profile/deployment-binding resolver plus compatibility `WORKFLOW.md` loader
- Strict accepted-governance manifest/tracker-policy resolver with exact Git ancestry, blobs, and
  digests; managed Attempts require a non-null pinned policy
- Typed config layer with defaults and `$` resolution
- Pinned managed configuration plus dynamic compatibility `WORKFLOW.md` reload/re-apply
- Polling orchestrator whose durable mutations pass through one transactional WorkSession store
- Lane-aware separation of authoring from delivery using stored policy plus live tracker facts
- WorkSession aggregate with tracker/interactive origins, revisions, pinned inputs, decisions,
  session-level human attachments, attempts, runtime/workspace leases, durable retries,
  materialization/proof/delivery records, effect intents, integrity checks, migrations, and backup
- Local manual WorkSession application and CLI with exact binding revalidation, revision/controller
  fencing, bounded plan admission, non-removable read-only attachment observation, secret-free
  status, restart continuity, and honest advisory/protected evidence posture
- Issue tracker adapter with state-list + ID-refresh reads
- Workspace manager with sanitized, collision-resistant per-issue workspaces
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- Hook timeout config (`hooks.timeout_ms`, default `60000`)
- Coding-agent app-server subprocess client with the targeted transport/framing protocol
- Exact managed Codex/systemd launch plus compatibility `codex.command`
- Strict prompt rendering with `issue` and `attempt` variables
- Exponential retry queue with continuation retries after normal exit
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- Reconciliation that stops runs on terminal/non-active tracker states
- Workspace cleanup for terminal issues (startup sweep + normal-poll and active transitions)
- Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- Operator-visible observability (structured logs; OPTIONAL snapshot/status surface)
- Managed descendant quiescence before runtime-lease release/expiry, with retained authority on
  observation failure
- Restart-safe materialization and delivery with exact PR/head, host-authenticated pinned WCP
  workflow/artifacts, product/lane grant intersection, Rework abandonment, guarded cleanup, and
  typed terminal tracker transition

### 18.2 RECOMMENDED Extensions (Not REQUIRED for Conformance)

- HTTP server extension honors CLI `--port` over `server.port`, uses a safe default bind host, and
  exposes the baseline endpoints/error semantics in Section 13.7 if shipped.
- Provider-native agent tools, when shipped, execute through the app-server session using
  host-side configured adapter auth without passing tracker secrets to the child.
- Managed Git-worktree driver, when shipped, implements the recorded-allocation, recovery,
  independent-verification, fresh-generation, and guarded-cleanup contract in Section 9.3.
- Pnpm preparation, when shipped, uses an offline frozen script/hook-disabled install inside a
  fail-closed network-less sandbox with an attempt-private cache, read-only operator seed, pinned
  dependency-policy digest, and recorded four-way outcomes.
- TODO: Make observability settings configurable in workflow front matter without prescribing UI
  implementation details.
- TODO: Extract common semantic helper tools only after multiple adapters demonstrate real
  duplication; do not preemptively replace provider-native tools with generic CRUD.

### 18.3 Operational Validation Before Production (RECOMMENDED)

- Run the `Real Integration Profile` from Section 17.8 with valid credentials and network access.
- Verify hook execution and workflow path resolution on the target host OS/shell environment.
- If the OPTIONAL HTTP server is shipped, verify the configured port behavior and loopback/default
  bind expectations on the target environment.

## Appendix A. SSH Worker Extension (OPTIONAL)

This appendix describes a common extension profile in which Symphony keeps one central
orchestrator but executes worker runs on one or more remote hosts over SSH.

Extension config:

- `worker.ssh_hosts` (list of SSH host strings, OPTIONAL)
  - When omitted, work runs locally.
- `worker.max_concurrent_agents_per_host` (positive integer, OPTIONAL)
  - Shared per-host cap applied across configured SSH hosts.

### A.1 Execution Model

- The orchestrator remains the single source of truth for polling, claims, retries, and
  reconciliation.
- `worker.ssh_hosts` provides the candidate SSH destinations for remote execution.
- Each worker run is assigned to one host at a time, and that host becomes part of the run's
  effective execution identity along with the issue workspace.
- `workspace.root` is interpreted on the remote host, not on the orchestrator host.
- The coding-agent app-server is launched over SSH stdio instead of as a local subprocess, so the
  orchestrator still owns the session lifecycle even though commands execute remotely.
- Continuation turns inside one worker lifetime SHOULD stay on the same host and workspace.
- A remote host SHOULD satisfy the same basic contract as a local worker environment: reachable
  shell, writable workspace root, coding-agent executable, and any required auth or repository
  prerequisites.

### A.2 Scheduling Notes

- SSH hosts MAY be treated as a pool for dispatch.
- Implementations MAY prefer the previously used host on retries when that host is still
  available.
- `worker.max_concurrent_agents_per_host` is an OPTIONAL shared per-host cap across configured SSH
  hosts.
- When all SSH hosts are at capacity, dispatch SHOULD wait rather than silently falling back to a
  different execution mode.
- Implementations MAY fail over to another host when the original host is unavailable before work
  has meaningfully started.
- Once a run has already produced side effects, a transparent rerun on another host SHOULD be
  treated as a new attempt, not as invisible failover.

### A.3 Problems to Consider

- Remote environment drift:
  - Each host needs the expected shell environment, coding-agent executable, auth, and repository
    prerequisites.
- Workspace locality:
  - Workspaces are usually host-local, so moving an issue to a different host is typically a cold
    restart unless shared storage exists.
- Path and command safety:
  - Remote path resolution, shell quoting, and workspace-boundary checks matter more once execution
    crosses a machine boundary.
- Startup and failover semantics:
  - Implementations SHOULD distinguish host-connectivity/startup failures from in-workspace agent
    failures so the same ticket is not accidentally re-executed on multiple hosts.
- Host health and saturation:
  - A dead or overloaded host SHOULD reduce available capacity, not cause duplicate execution or an
    accidental fallback to local work.
- Cleanup and observability:
  - Operators need to know which host owns a run, where its workspace lives, and whether cleanup
    happened on the right machine.
