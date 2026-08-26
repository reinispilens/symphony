# Manual WorkSession MVP plan

- Status: implementation complete with deterministic restart journey; live binding journey waits
  for the final accepted-governance repin and composed Dyslexify autonomous pilot. Follow-on phase of
  [`orchestration-estate-alignment-plan.md`](orchestration-estate-alignment-plan.md)
- Recorded: 2026-08-25; revised after whole-plan state and authority review
- Repository: Symphony
- Technical prerequisites: the alignment plan's WorkSession store, accepted product/deployment
  resolver, and accepted-doctrine resolver
- Rollout gate: scheduled after the RepositoryDriver, protected proof, delivery, doctrine/template
  alignment, and Dyslexify autonomous pilot so the estate finishes one migration path before opening
  a second control surface
- MVP commands: `start`, `attach`, `plan`, `steer`, and `status`
- Later extension: controller handoff

## The model in one picture

```text
                         one SymphonyStateStore
                                  │
                         one WorkSession model
                   origin: tracker | interactive
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
        tracker controller                  human controller
      autonomous board work              current chat/CLI work
                 │                                 │
                 └──────── same attempts, workspaces,
                           doctrine, decisions, proof,
                           delivery and evidence ───────┘
```

The manual feature is a second way to control the same operational record, not a second
orchestrator and not a second database. The human remains the orchestrator: Symphony makes the
session durable, records plan and steering, describes its current state, and enforces workspace
ownership. It does not require a board or turn the user's conversation into autonomous work.

## Why this exists

The user is already driving work manually in a live coding conversation: choosing the outcome,
asking for a plan, correcting boundaries, and steering execution. Today those decisions live mainly
in model context. A restart or new client requires reconstruction.

The MVP gives that existing workflow a durable identity with the smallest useful surface:

```text
start  → name the work and create durable state
attach → identify the human-owned checkout being used
plan   → replace the current intended steps and acceptance criteria
steer  → append a decision or correction without rewriting history
status → explain intent, plan, workspace, attempt and evidence state
```

No approval ceremony is added. An explicit local user command is the initiation authority for an
interactive-origin WorkSession.

## Relationship to the estate plan

The foundation plan deliberately creates `WorkSession` before the repository driver. Tracker-origin
work is the first consumer. This plan adds only the human-facing controller and CLI after the
autonomous Dyslexify path proves the common mechanics.

This ordering avoids two previous design errors:

1. Attempts are not tracker-shaped records with mandatory issue IDs. Both origins are valid at the
   aggregate root.
2. Manual control does not introduce a later `WorkSessionStore` beside durable tracker-attempt
   records.
   Every operation uses the same transactional `SymphonyStateStore` and fencing rules.

Most of the rollout gate is sequencing, not technical coupling. `start`, `attach`, `plan`, `steer`,
and `status` do not call WCP or delivery. Waiting until after the autonomous pilot keeps the current
estate migration focused; it must not cause the manual application service to import those systems
or pretend they are needed for a boardless record.

One WorkSession binds one repository identity and one accepted Symphony deployment binding. A
cross-repository program such as the estate migration remains a coordinating plan plus separate
repository-owned changes; the MVP does not invent an atomic multi-repository session manager.

`SPEC.md` gains a manual-control extension together with implementation. `.github` doctrine is
rescoped so board status remains the only start authority for tracker-linked work, while an explicit
local user command may start boardless interactive work.

## Scope

### In the MVP

- Start a boardless interactive WorkSession for one repository.
- Attach an existing checkout as human-owned and non-removable.
- Persist the current plan and acceptance criteria.
- Append steering decisions with time and expected WorkSession revision.
- Show a cohesive status view after process restart.
- Use the same pinned doctrine snapshot, decision log, attempts, and evidence references as tracker
  origin.

### Deliberately later

- Human-to-tracker or tracker-to-human controller handoff.
- Board linking and driver-label mutation.
- Pause/resume protocol.
- Manual `prove` or `deliver` commands.
- Managed-worktree creation from the manual CLI.
- Doctrine rebase for an existing session.
- MCP, HTTP, editor, or chat-provider integration.
- Capturing or uploading a dirty checkout as protected proof source.
- Atomic multi-repository WorkSessions or a program-management layer.

The CLI can grow only after a real journey proves a missing operation. Command breadth is not the
goal; durable comprehension and safe ownership are.

## Shared state model

The foundation owns this shape:

```text
WorkSession
├── id and optimistic-concurrency revision
├── origin
│   ├── tracker { tracker kind, repository identity, opaque item id, display id }
│   └── interactive { repository identity, initiating actor }
├── intent and acceptance criteria
├── pinned doctrine { repository, path, revision, digest }
├── accepted product profile + context digests
├── deployment-binding identity + digest
├── controller assignment + fencing generation
├── ordered decision/steering log
├── 0..1 human attachment { path, repository/head/status facts, removal = never }
├── 0..n Attempts
│   ├── 0..1 fenced runtime lease
│   └── 0..1 managed or compatibility workspace lease
├── source-materialization + proof correlations
└── delivery saga
```

The MVP does not add tables or sidecar files. It calls the WorkSession application service, which
transacts through `SymphonyStateStore`.

The CLI is deliberately local-only in this phase. Access to the explicit operator-binding file and
its private Symphony state root by the same operating-system account is the caller boundary;
the state directory is mode `0700` and database files are mode `0600`. No network listener or bearer
controller token is introduced. A future remote controller would need a separate authentication
contract rather than inheriting this local trust assumption.

Controller assignment and runtime lease are different facts:

- The controller assignment says who may decide what happens next.
- The runtime lease says whether one execution is active now.

Every human/controller mutation supplies the expected WorkSession revision. A successful mutation
increments it. Runtime and external-effect operations additionally carry the controller generation,
the relevant runtime/effect token, and an idempotency key. A stale CLI or daemon may read status but
cannot write or act. `revision` and `controller generation` are deliberately different names: the
first detects concurrent edits; the second invalidates prior authority after reassignment.

The record-only command path uses the same strict binding resolver but does not require an unused
delivery-provider secret to be present. It still validates the declared provider/executable and
all accepted authority; it simply makes no provider call and gives no credential to the command.

## Workspace boundary

The MVP adds one session-level reference to the WorkSession domain. It is intentionally not a
RepositoryDriver workspace lease:

| Record kind        | Checkout created by    | May work be authored there?                              | May Symphony remove/reset/clean it? |
| ------------------ | ---------------------- | -------------------------------------------------------- | ----------------------------------- |
| `human-attachment` | Human or external tool | Human-directed only; the five-command MVP spawns nothing | Never                               |

`attach` creates no Attempt and acquires no runtime or workspace lease. That distinction keeps
“remember where the human is working” separate from “Symphony owns an execution workspace.” The
RepositoryDriver and all cleanup/materialization APIs accept only managed/compatibility lease
types; an attachment cannot be passed to them.

`attach` performs read-only validation before recording:

1. Resolve a real absolute directory and repository root.
2. Verify its remote/repository identity matches the WorkSession's pinned product identity; a path
   for another repository cannot be attached merely because the caller can access it.
3. Record current head when available and whether tracked/untracked/ignored changes exist.
4. Refuse a path inside Symphony's state/control roots or already leased by any other nonterminal
   WorkSession, whether managed or attached.
5. Persist `ownership = human` and `removal_policy = never` as typed state, not prose.
6. Never run Git cleanup, reset, checkout, worktree removal, or dependency teardown on that path.

Attaching authorizes recording and human-directed authoring in that checkout. It does not authorize
Symphony to adopt ownership.

The five-command MVP records and explains the current human-directed session; it does not spawn a
new Codex process or silently replace the coding client's own sandbox. The estate plan's exact
managed-runtime policy applies to Symphony-created `managed` workspaces. An `attached` checkout
remains human-owned, and adding a Symphony execution command for it would require a separate
authority and sandbox contract rather than reusing managed cleanup rights.

For the same reason, the MVP records and displays the pinned doctrine and product-context
references but does not inject them into an already-running external coding client. The human may
route that client to the recorded context. Automatic client integration is a later transport
feature, not hidden behavior of `attach`.

## Proof boundary for dirty attached work

Workspace Control Plane proves immutable source. A dirty checkout has no Git source identity that a
fresh VM can reconstruct, so its local tests are useful feedback but not authoritative protected
proof.

```text
attached dirty checkout ──► local/advisory evidence only

committed immutable SHA ──► WCP protected plan, execution and verdict
```

The MVP reports this distinction in `status`; it does not invent a content-snapshot upload protocol.
Such a protocol may be designed later if real manual journeys need pre-commit protected proof.

## CLI contract

Command spelling is part of the MVP once implemented:

```text
symphony work start  --binding /absolute/operator/deployment-binding.json --intent <text>
symphony work attach --binding /absolute/operator/deployment-binding.json --session <id> --expected-revision <n> --path <checkout>
symphony work plan   --binding /absolute/operator/deployment-binding.json --session <id> --expected-revision <n> --file <plan.md>
symphony work steer  --binding /absolute/operator/deployment-binding.json --session <id> --expected-revision <n> --message <text>
symphony work status --binding /absolute/operator/deployment-binding.json --session <id> [--json]
```

Every command repeats the same exact binding. A session ID identifies a row inside the
binding-owned state store but cannot locate that store by itself. Requiring explicit authority on
each short-lived invocation preserves the plan's no-registry/no-sidecar boundary.

### `start`

Selects an explicit absolute operator-owned deployment-binding file; arbitrary workflow and
candidate-repository binding paths are not accepted. Symphony applies the daemon's existing
binding resolver and pins the file's stable internal ID and digest, its accepted product
profile/context snapshot, and the accepted doctrine reference; creates the interactive-origin
WorkSession; sets the local human controller assignment; and returns the session ID, WorkSession
revision, and controller generation. It creates no board item and no workspace.

### `attach`

Records a validated human-owned checkout directly on the WorkSession. It creates no Attempt or
lease and refuses a second active attachment, any conflicting WorkSession lease, unsafe
containment, repository mismatch, or stale revision. It changes no repository bytes.

### `plan`

Replaces the current typed plan and increments its version. The Markdown input must contain exactly
one `## Plan` and one non-empty `## Acceptance criteria` list; those sections become the two typed
projections shown by `status`. The MVP retains the current plan rather than superseded plan bodies;
the decision/steering/exception log is the append-only history. It does not execute work.

### `steer`

Appends a concise decision/correction to the event log. An agent may propose a golden-principle
exception, but this command records it as accepted only when invoked by the authorized human
controller and cited as `EXCEPTION GP-xx: <reason>`.

### `status`

Reads without acquiring control. Human output begins with intent and recorded WorkSession state,
then plan,
workspace ownership, active attempt/runtime lease, proof authority, delivery state, doctrine digest,
and the latest steering decisions. `--json` exposes a versioned projection, never raw database rows.

## Implementation phases

### M0: doctrine and contract gate

Technical gate:

1. The foundation WorkSession model and store are live for tracker origin.
2. `.github` doctrine explicitly scopes board start authority to tracker-linked work.
3. The accepted golden-principles reference can be pinned for a new WorkSession.
4. An explicit operator-binding file can resolve one accepted product profile and context snapshot
   without reading authority from the attached/candidate checkout.

Program-order gate:

5. The Dyslexify autonomous pilot has proven repository, proof, delivery, recovery, and cleanup.

**Exit:** manual control can reuse proven mechanics without contradicting live doctrine.

### M1: WorkSession application operations

1. Add `startInteractive`, `attachWorkspace`, `replacePlan`, `appendSteering`, and `getStatus` to a
   transport-independent application service.
2. Validate expected WorkSession revisions and controller assignment on all human writes; preserve
   the separate controller-generation fence for runtime/effect authority.
3. Model the human attachment as a session-level exhaustive type outside the Attempt workspace-lease
   union; cleanup and materialization cannot accept it.
4. Bind the interactive origin, attached checkout, accepted product profile/context, and deployment
   binding to one repository identity.
5. Return stable domain errors for stale revision, stale controller generation, unsafe path,
   repository mismatch, workspace conflict, missing doctrine/binding, and unauthorized exception
   acceptance.

**Exit:** deterministic unit tests exercise every operation without a CLI.

### M2: CLI

1. Add the five commands and human-oriented output.
2. Add versioned JSON status output for tools.
3. Keep secrets, raw prompts, transcripts, and private checkout contents out of durable state and
   logs.
4. Document local backup and recovery of the shared SQLite state store.

**Exit:** a user can restart the client and continue to understand and steer the same session.

### M3: current-session journey

Pilot the exact workflow that motivated the feature:

1. Start a boardless session from that repository's explicit operator-binding file.
2. Attach the matching existing dirty checkout without changing it.
   Verify this records only the session-level attachment and creates no Attempt or lease.
3. Record the plan and at least two steering corrections.
4. Close every CLI/application process, then reopen the state store from a fresh process.
5. Read status and verify intent, plan revision, workspace ownership, product/context and deployment
   digests, doctrine digest, and steering history.
6. Attempt every Symphony cleanup entrypoint against the attached path and require mechanical
   refusal.
7. Report local proof as advisory until a commit supplies immutable source.

**Exit:** recorded evidence proves continuity and non-ownership.

## Acceptance tests

1. **No implicit board:** `start` creates no issue, card, label, or remote mutation.
2. **One state system:** tracker and interactive sessions are queryable through the same store and
   schema; no manual sidecar exists.
3. **Trusted start:** `start` accepts only an absolute operator-binding file, pins its internal ID
   and digest plus the accepted product profile/context and doctrine, and refuses candidate-owned
   binding/workflow paths or mismatched bytes.
4. **Concurrency:** two processes update the same revision; exactly one succeeds and the stale one
   receives the current revision.
5. **Fencing:** a process holding an old runtime lease token or controller generation cannot mutate
   runtime/workspace state or finish a queued effect.
6. **Attached safety:** dirty, clean, detached-head, nested, symlink, repository-mismatch, and
   conflicting-worktree fixtures either attach safely or refuse; successful attachment creates no
   Attempt/runtime/workspace lease, and no cleanup code can remove an attached path.
7. **Restart:** plan and steering survive abrupt process exit and database reopen by a fresh
   process.
8. **Local caller boundary:** private state/binding permissions are enforced; no network control
   surface or reusable bearer secret appears in the MVP.
9. **Privacy:** state and logs contain structured intent/decisions, not transcript bodies, secrets,
   environment dumps, or repository file contents.
10. **Proof honesty:** dirty attached state is visibly advisory; committed source may reference a WCP
    protected result only when SHA and plan digest match.
11. **Doctrine continuity:** a new session pins the accepted source; later amendments affect new
    sessions, not the existing one; only the human controller can accept `EXCEPTION GP-xx`.

## Later controller-handoff extension

Handoff is intentionally absent from the MVP. When a real need schedules it, the board transition
must respect current `.github` doctrine:

```text
stop runtime
  → finish the current Attempt
  → move the linked issue to Backlog
  → change driver label
  → move to Todo
  → target controller starts a new Attempt in the same WorkSession
```

The driver label never changes inside an active attempt. Autonomous tracker control initially
requires a Symphony-managed workspace; an attached human checkout is not silently adopted. The
handoff design must prove exclusive controller assignment, zero/one runtime lease, fencing across
crashes, and recovery of every partial external mutation before it can ship.

## Definition of done

The MVP is done when a human can select an explicit operator-binding file, start, attach, plan,
steer, restart, and inspect one durable WorkSession without a board; the tracker path still uses the
same state model; attached workspaces are identity-matched and mechanically non-removable;
dirty-tree evidence is labeled advisory; attachment creates no synthetic Attempt; and no automatic
agent execution, multi-repository coordinator, handoff, copied orchestration, binding registry, or
second store has been introduced.

## Implementation outcome

The Node implementation now contains the transport-independent application service and all five
commands. Deterministic tests prove exact binding scoping, controller and optimistic-revision
fencing, current-plan parsing/versioning, exception syntax and authority, read-only real-Git
attachment inspection, symlink/control-root/repository refusals, no synthetic Attempt or lease,
cross-process SQLite reopen, bounded status projection, token/error omission, and conservative
advisory/protected evidence classification. An end-to-end journey runs the real CLI across five
fresh Node processes against temporary product/governance Git repositories, one version-3 binding,
and one independently reopened SQLite store.

The unavoidable contract correction is that `--binding` appears on every command. No existing
registry can locate an arbitrary private state root from a session UUID, and creating one would
contradict the approved single-store boundary.

Two rollout facts remain. Spec 001 must publish so the deployment can repin the final accepted
doctrine that explicitly permits local human initiation, and the composed Dyslexify autonomous
pilot must prove the shared authoring, proof, delivery, recovery, and cleanup path. Until then, the
deterministic journey is implementation evidence, not a claim that a live boardless session is an
accepted estate capability. Those gates do not justify changes to `.github` files from this branch
or any product-repository harness.

## Lifetime of this document

After M3 is accepted, the command and state contract moves to `SPEC.md`, operator usage and recovery
move to `README.md` and `docs/operations.md`, and the acceptance cases remain executable tests. The
motivation, rollout order, and current-session journey remain historical planning evidence only;
this file is archived and does not become a second manual-control specification.
