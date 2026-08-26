# Accepted governance composition plan

Status: `.github` contribution prepared and Symphony runtime plus boardless manual controller
implemented; accepted repin and consumer pilot pending, 2026-08-27

Parent plan: [orchestration estate alignment](orchestration-estate-alignment-plan.md), Phase 6.

Current ownership is explicit. Spec 001 on branch `001-doctrine-centralization` owns golden-
principles reconciliation, the estate checker, and the ported enforcement-tiers,
system-conformance, and documentation-lifecycle documents. This work owns only onboarding,
delivery cadence, and tracker policy in `.github`; its accepted-snapshot digest is intentionally
repinned once, by the Spec 001 owner, after final golden-principles wording lands. In Symphony,
sections B and C plus Section D's manual-control item are implemented locally and must pass the
complete Node gate before landing. The template and consumer journey in Section D remain later
integration work and do not weaken the consumer boundary.

## The change in one picture

```text
personal .github repository
  accepted-governance.json at one operator-pinned commit
    ├── golden-principles.md at acceptedRevision + digest
    └── tracker-policy.json at acceptedRevision + digest
                         │
                         │ read and verified outside candidate execution
                         ▼
Symphony deployment binding v3
  ├── product repository profile at exact commit + digest
  ├── operator host/runtime/provider authority
  └── governance checkout + exact manifest reference
                         │
                         ▼
new WorkSession
  ├── immutable doctrine reference
  ├── immutable typed tracker-policy snapshot
  ├── immutable product/configuration references
  └── live tracker facts interpreted through that pinned policy
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
   authoring Attempt              delivery reconciliation
   only in authoring lane         only for lane + product-grant intersection
```

The product repository declares product intent and delivery scope. It does not choose the global
policy revision, host checkout, runtime path, credentials, or delivery algorithm. The operator
binding identifies the accepted governance publication. Symphony verifies and pins it before a new
Attempt can execute.

## Outcomes

1. One accepted `.github` publication supplies doctrine, lane semantics, driver selectors, retry
   semantics, and delivery-operation meanings.
2. Every new managed WorkSession carries a non-null doctrine reference and a complete typed tracker
   policy snapshot. Restart never silently switches a running session to newer governance.
3. Deployment-binding v3 removes repeated global tracker values. Version 1 and 2 documents remain
   readable compatibility inputs, but cannot create a newly executable managed Attempt after the
   governance gate is installed.
4. Tracker-origin authoring and delivery are separate. An `active` lane means Symphony reconciles
   it; only a lane with `authoring: true` may launch Codex.
5. A delivery operation occurs only when both the current lane and the pinned product delivery
   grant permit it. `owner-gated` can never produce a merge mutation.
6. Product repositories and the workspace template retain only thin repository/proof declarations
   and product-shaped tests. No Symphony lifecycle implementation moves into them.

## Non-goals

- Do not copy GP-01–GP-20 prose into Symphony, a deployment binding, or a product repository.
- Do not make `.github` executable code part of Symphony's runtime. Symphony owns an independent
  strict parser for the portable JSON contract.
- Do not let a candidate worktree, prompt, agent response, board comment, or environment variable
  select governance.
- Do not add a second WorkSession or delivery state model for boardless manual control.
- Do not modify Dyslexify's harness, proof semantics, product test meaning, or known harness defects.

## Contract decisions

### G1. Publication indirection is deliberate

The operator pins one manifest reference:

```json
{
  "repositoryIdentity": "reinispilens/.github",
  "sourceRoot": "/operator/checkout/.github",
  "manifest": {
    "path": "agent-system/accepted-governance.json",
    "revision": "<exact publication commit>",
    "digest": "sha256:<exact manifest bytes>"
  }
}
```

The manifest then names `acceptedRevision` plus exact doctrine and tracker-policy paths/digests.
This permits a candidate policy change to merge before a later publication commit accepts it. The
publication test verifies blobs at `acceptedRevision`; it must not compare a still-unaccepted
working-tree candidate with the currently published manifest.

### G2. Deployment binding v3 owns host location, not policy content

Version 3 adds the governance checkout and manifest reference and removes the repeated global
tracker fields (`requiredLabels`, `excludedLabels`, active/terminal/fresh-attempt states, and the
fresh-attempt failure target). It keeps repository-specific provider identity and operator capacity.
The accepted tracker policy derives the removed values. Its delivery-provider authority also pins
the transport seam from one product-required check to an exact `pull_request_target` caller and
immutable WCP reusable workflow. The product still owns which check is required and what product
proof means; it cannot choose the host trust anchor.

Version 1 and 2 continue to parse for historical inspection and controlled migration. If their
repeated values disagree with resolved governance they are refused. Without resolved governance
they cannot admit a new managed Attempt.

### G3. The WorkSession stores a usable immutable value

A portable reference alone cannot drive restart recovery when the governance checkout is absent or
has advanced. `AcceptedConfigurationSnapshot` therefore stores:

- the accepted-governance manifest reference;
- a typed tracker-policy snapshot containing its source reference and validated policy values; and
- the existing product profile/context/binding and delivery grant; and
- the operator-owned protected-proof authority needed to authenticate the delivery check after a
  daemon repin.

The existing top-level `doctrine` field stores the doctrine artifact reference. Historical null
values remain parseable. `startAttempt` refuses a managed configuration whose doctrine or tracker
policy is null; it does not corrupt or delete the historical session.

### G4. Policy selection and live facts stay separate

The pinned policy answers what a lane means. The tracker adapter supplies the issue's current lane,
state version, labels, and identity. Symphony combines them at reconciliation time:

```text
pinned lane meaning + live issue state/version + pinned product grant
                              │
                              ▼
                  one typed runtime authority
```

Driver labels are fail-closed: tracker-origin authoring requires exactly the policy's Symphony
selector and excludes every other declared driver selector. A driver change remains legal only in
the policy's `changeOnlyInLane` lane before a new Attempt.

### G5. Delivery is an application port, not another agent turn

The Orchestrator receives one `DeliveryExecutionPort`. The production implementation composes the
trusted materializer, external delivery provider, durable coordinator, and repository cleanup.
Tests use a fake port.

After a completed managed Attempt:

1. refresh the exact issue;
2. if its pinned lane permits authoring, schedule the existing bounded continuation;
3. if its lane permits materialization, materialize once and start/resume delivery;
4. if waiting for checks or owner action, persist and return without sleeping or starting Codex;
5. if local cleanup is required, call the RepositoryDriver with the recorded WorkSession authority,
   then mark cleanup complete;
6. reconcile every active pending delivery by WorkSession ID on later ticks and restart.

`Human Review` may deliver and observe an external merge but cannot create a merge mutation.
`Merging` may create a merge only when the pinned grant is `full-in-scope`. A merged delivery may
move to `Done` only through a typed tracker-control operation and only after guarded cleanup.
Managed candidate status tools derive their non-terminal targets from the WorkSession's pinned lane
writers; the GitHub provider's `agent_status_targets` remains compatibility-only and cannot widen
accepted policy.

### G6. Rework closes the prior delivery before fresh authoring

`Rework` is authoring plus fresh-attempt authority, not permission to leave an old PR and remote
branch orphaned. The provider contract gains exact pull-request closure. Reconciliation first closes
an unmerged exact PR, releases its exact remote branch, and performs guarded workspace cleanup.
Only then may the existing fresh-attempt generation create a replacement workspace. Completed or
refused prior delivery remains in `deliveryHistory`.

### G7. Exception acceptance is one state operation

Both tracker-origin and later interactive acceptance call the existing revisioned decision append.
An accepted exception records actor, GP ID, reason, doctrine reference, and expected WorkSession
revision. Tracker-origin acceptance additionally requires a structured action authored by a human
who has repository decision authority; proposal text or an agent-authored action is never
acceptance. This route is implemented only after the tracker adapter exposes authenticated action
facts; no comment-text heuristic is permitted.

## Implementation sequence

### A. Contribute the assigned `.github` contract slice

1. Add an explicit fresh-attempt failure lane to `tracker-policy.json` and its strict loader.
2. Rewrite onboarding around a thin Symphony repository profile, thin WCP proof declaration,
   product `prove` entrypoint, operator binding, and optional tracker registration.
3. Rewrite delivery cadence as global authority seams and owner routes rather than copied product
   commands.
4. Replace lifecycle-mechanics tests for those owned files with negative boundary/routing tests.
5. Do not edit the golden-principles reconciliation, estate checker, or ported
   enforcement-tiers/system-conformance/documentation-lifecycle documents. Spec 001 on branch
   `001-doctrine-centralization` owns them.
6. Contribute this slice to Spec 001. Its owner performs one accepted-snapshot repin only after the
   final GP wording and tracker-policy bytes have landed together.

### B. Resolve and persist accepted governance in Symphony

1. Add strict tracker-policy and accepted-manifest parsers with exact key sets and semantic checks.
2. Add deployment-binding v3 parsing and the operator-owned governance reference.
3. Pin one operator-owned proof authority and require its check to be present in the product grant;
   authenticate GitHub's run event/head/caller/referenced-workflow facts before admitting WCP
   artifacts.
4. Verify governance checkout root, repository identity, exact revisions, ancestry, regular Git
   blobs, byte bounds, UTF-8, and all configured digests outside governed roots.
5. Require the product delivery grant's governing-policy reference to equal the resolved accepted
   tracker-policy reference exactly.
6. Derive tracker runtime values and driver selectors from the policy; reject legacy disagreement.
7. Persist doctrine, manifest, typed policy, and proof authority on new WorkSessions; fence new Attempts with null
   governance while retaining historical readability.
8. Expose portable references—not normative prose—to prompt/status projections.

### C. Compose tracker reconciliation and delivery

1. Add the `DeliveryExecutionPort` and production composition in `buildDaemonHost`.
2. Split fetched issues into authoring, delivery-only, terminal-cleanup, and inert lanes according to
   the pinned policy.
3. Replace unconditional successful continuations with lane-aware authoring or delivery.
4. Reconcile persisted delivery sessions at startup and on polls without consuming agent slots.
5. Add typed tracker status transition and structured exception-action ports.
6. Add exact PR closure/release for Rework before fresh workspace replacement.

### D. Consumer and manual-control gates

1. Rebuild the workspace template to contain only thin declarations and product proof.
2. Configure Dyslexify's v2 repository profile and an external v3 deployment binding; do not alter
   its harness.
3. Run one disposable board-backed journey through authoring, Human Review, protected WCP proof,
   Merging, cleanup, and Done, including restart and cancellation evidence.
4. The boardless `symphony work` commands are implemented over the same state/application ports;
   their deterministic human-driven restart journey is green. Run the live equivalent only after
   the final accepted-governance repin.

## Proof matrix

| Boundary            | Required proof                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Publication         | manifest digest, exact accepted revision, artifact blob digests, no local paths                          |
| Governance checkout | exact Git root/origin identity, disjoint roots, no symlink substitution                                  |
| Tracker policy      | strict schema, unique lanes/drivers, explicit failure lane, safe merge/profile invariants                |
| WorkSession         | new sessions pin non-null values; old null records parse but cannot start an Attempt                     |
| Drift               | an amended checkout does not change an existing WorkSession; a new publication changes only new sessions |
| Product grant       | exact equality with accepted tracker-policy reference; mismatch refuses startup                          |
| Proof authority     | exact product-check membership plus host run event/head/caller/control-workflow identity                 |
| Authoring           | `active && !authoring` never starts Codex; exact Symphony driver required                                |
| Delivery            | exact head/check/proof; owner-gated never merges; full-in-scope also needs Merging                       |
| Restart             | every materialization/provider/effect boundary resumes without duplicate mutation                        |
| Rework              | exact old PR/branch/workspace resolved before fresh Attempt                                              |
| Boundary            | product/template contain no generic worktree, preparation, delivery, or cleanup implementation           |

## Rollout and rollback

The rollout is additive until the final consumer pilot. Existing binding versions and historical
WorkSessions stay readable. No existing product repository is rewritten merely to prove the new
schema. The first real v3 binding is external and targets a disposable Dyslexify board item.

If governance resolution fails, Symphony refuses new managed execution before SQLite mutation,
worktree allocation, agent launch, or remote delivery. Rollback means restoring the previous daemon
binary and binding; it never means editing a WorkSession, weakening a digest, or copying governance
into the product repository.
