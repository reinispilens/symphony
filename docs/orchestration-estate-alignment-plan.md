# Agent authoring estate alignment plan

- Status: approved execution plan; implementation evidence is recorded phase by phase
- Recorded: 2026-08-25; revised the same day after whole-plan authority and state-model review
- Coordinating repository: Symphony
- Repositories in scope: Harness Engineering, the personal `.github` control plane, Workspace Repo
  Template, Symphony, and Workspace Control Plane. A2A Fleet is recorded only as a separate
  follow-on retirement candidate.
- Consumer in scope: every product repository, beginning with Dyslexify as the pilot
- Companion plan: [`interactive-control-plan.md`](interactive-control-plan.md) adds the manual
  `start`, `attach`, `plan`, `steer`, and `status` surface over the WorkSession foundation delivered
  here. Controller handoff is a later extension, not part of that MVP.

This document coordinates a migration across repositories that retain separate authority. It is
not a new permanent source of truth for the estate. Each accepted contract must ultimately
live with its semantic owner; the [lifetime section](#lifetime-of-this-document) at the end says
where every section goes when this plan is archived.

Related Symphony decisions:

- [`repository-driver-boundary.md`](repository-driver-boundary.md) defines why reusable repository
  lifecycle machinery belongs in Symphony. This plan schedules that decision; it does not restate
  it.
- [`dyslexify-orchestration-handoff.md`](dyslexify-orchestration-handoff.md) applies that boundary
  to the first product pilot.

## Execution checkpoint

Updated 2026-08-26. A merged commit is accepted authority; a local candidate remains evidence only.

| Phase | Evidence                                                                                                                                                                                 | Status / next boundary                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 0     | Golden principles and estate boundaries merged in `.github`; portable governance publication merged at `7b98b03` and pins accepted source `7309109` plus exact doctrine/policy digests   | Complete                                               |
| 1–3   | Symphony durable WorkSession, RepositoryDriver, managed worktrees, exact binding/context, systemd quiescence, and offline pnpm preparation merged at `7514735`                           | Complete                                               |
| 4     | WCP proof v2 and runner admission merged through `c1d1983`; Dyslexify push and PR canaries passed; cancelled attempt removed both GitHub runner and GARM VM with no residue              | Complete                                               |
| 5     | Local Symphony candidate implements bounded source materialization, typed delivery provider, durable exact-head saga, authority-separated merge, remote release, and crash/restart tests | Run full gates, review, and merge before claiming exit |
| 6a    | `.github` tracker policy and derived board/driver tooling merged at `7309109`; accepted publication merged at `7b98b03`                                                                  | Onboarding/boundary retirement remains                 |
| 6b–9  | No exit claimed                                                                                                                                                                          | Implement and prove each owner in the order below      |

This checkpoint prevents two opposite errors: describing already-written candidate code as merely
"proposed," or describing unmerged code as an accepted estate capability.

## What this plan is, in one sentence

The Dyslexify pilot proved that Symphony pushes its worktree, receipt, retry, and cleanup machinery
into every product repository; this plan establishes one durable Symphony WorkSession model, moves
that machinery back behind Symphony, establishes protected proof, and then thins every consumer.

## The estate in one picture

```text
Harness Engineering ── methods/evidence ──▶ ~/.github governance
                                              │ board facts + pinned doctrine
                                              ▼
human controller ── start/plan/steer ──▶ Symphony
                                         authoring + delivery
                                                │
Symphony/WCP schemas ── design-time ──▶ Workspace Repo Template
                                                │ one-time scaffold
                                                ▼
                                          product repository
                                      product truth + thin adapters
                                           │              │
                      thin profile/context │              │ immutable source +
                                           ▼              │ thin proof declaration
                                        Symphony          ▼
                                                  Workspace Control Plane
                                             isolated proof + authenticated verdict
                                                           │
                                                           └──▶ GitHub/Symphony correlation

A2A Fleet ── frozen; no operating seam; separate archive/retirement decision
```

The template touches a product only when it is generated; it has no runtime edge to Symphony. The
human and tracker are two initiation authorities for the same Symphony WorkSession model. A2A is
shown precisely because it is disconnected: this alignment neither depends on it nor moves its
scheduler or worktree code into another repository.

Symphony owns the common authoring mechanics and operational state. It does not own the decisions:
the board authorizes tracker-origin work, an explicit human request authorizes interactive-origin
work, the product repository defines what correct means, and Workspace Control Plane decides
whether protected proof is trustworthy. WCP also retains its existing narrow doctrine-publication
bridge: it copies no prose, interprets no rule, and only generates deterministic pointers from the
canonical `.github` source.

## Intended outcomes

The migration is successful when the following are simultaneously true.

1. One transactional `SymphonyStateStore` owns every WorkSession, accepted configuration/context
   snapshot, child attempt, runtime lease, workspace lease, materialization/delivery saga, doctrine
   snapshot, and decision-log event.
2. A Symphony-managed worktree has centrally implemented creation, ownership, recovery, and
   guarded cleanup, recorded durably outside the candidate workspace.
3. A new product repository contains product truth and thin declarations, not copied Symphony or
   Workspace Control Plane machinery.
4. Product claims are declared by the product, but the minimum proof is selected by protected
   base-owned policy, admitted and executed under Workspace Control Plane authority, and correlated
   to the exact source by Symphony.
5. Source materialization and delivery (immutable tree/commit, pull request, required checks,
   merge, cleanup) are durable Symphony records that survive daemon restart.
6. Accepted engineering principles live once at
   `~/.github/agent-system/golden-principles.md`; methodology is retrieved from Harness Engineering,
   and neither is copied into product repositories.
7. Every WorkSession records the exact accepted doctrine revision and content digest it used, plus
   human-accepted principle exceptions, so restart cannot silently change the rules governing
   in-flight work.

## Non-goals

This plan does not:

- Define the human-interactive CLI contract or add controller handoff here. This estate plan
  schedules the manual MVP as Phase 9, but the command behavior and acceptance contract live only
  in the [interactive control plan](interactive-control-plan.md). Controller handoff remains later.
- Move product tests, domain rules, required-check policy, or product architecture into Symphony.
- Move Git worktree or delivery orchestration into the repository template.
- Turn Workspace Control Plane into an authoring environment or task scheduler.
- Build a universal plugin framework before the first concrete repository and proof drivers need
  one.
- Modify all repositories in one cross-repository change. Each repository must accept its own
  narrow change through its own authority and gates.
- Retire A2A Fleet or onboard Core, Market Intelligence, or Platform Infra. Those are independent
  follow-on decisions and are not completion dependencies for this five-repository alignment.

## Shared vocabulary

The repositories currently use words such as task, issue, attempt, worker, workspace, and harness
for overlapping ideas. Alignment begins by assigning one meaning to each cross-system concept.
`WorkSession` is the common root now; the companion plan adds only the manual controller and its
human-facing operations.

| Concept                 | Meaning                                                                             | Semantic owner                                                     |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| WorkSession             | One durable authoring trajectory, independent of how it was initiated               | Symphony                                                           |
| Session origin          | `tracker` with immutable tracker identity, or `interactive`                         | Symphony contract; initiating authority supplies values            |
| Work request            | Desired outcome carried by a WorkSession                                            | Tracker item or explicit human request                             |
| Attempt                 | One bounded agent execution inside one WorkSession                                  | Symphony                                                           |
| Runtime lease           | Fenced, renewable permission for one attempt to execute                             | SymphonyStateStore                                                 |
| Repository profile      | Trusted product identity, authoring context, preparation need, and delivery grant   | Product repository declares; Symphony owns schema and validation   |
| Deployment binding      | Accepted profile reference plus host roots, runtime, limits, and secrets            | Symphony operator/deployment authority                             |
| Human attachment        | Human-owned checkout recorded for an interactive session; never an Attempt lease    | Human owns bytes; Symphony owns only the typed reference           |
| Managed workspace       | Worktree created and lifecycle-managed by Symphony for an attempt                   | Symphony                                                           |
| Workspace record        | Durable Symphony record proving ownership of a managed workspace                    | Symphony                                                           |
| Runtime invocation      | One Codex (or future runtime) execution                                             | Symphony                                                           |
| Source materialization  | Trusted conversion of a stopped managed worktree into one immutable tree and commit | Symphony                                                           |
| Proof request           | Source-bound request to execute accepted product checks                             | Product contract plus Workspace Control Plane admission            |
| Proof result            | Immutable evidence tied to source, adapter, environment, and attempt                | Workspace Control Plane                                            |
| Delivery record         | Correlation of branch, PR, immutable head, checks, merge, and cleanup               | Symphony                                                           |
| Workpad                 | Optional human-readable projection; tracker sessions use an issue comment           | `.github` defines tracker convention; Symphony writes projections  |
| Tracker policy snapshot | Versioned lane, driver, and retry semantics governing a tracker-origin WorkSession  | `.github` owns the policy; Symphony pins and applies it            |
| Doctrine revision       | Exact accepted global doctrine source, revision, and content digest                 | `.github` owns content; WorkSession records the snapshot           |
| Doctrine exception      | Human-accepted deviation `EXCEPTION GP-xx: <reason>`                                | `.github` owns protocol; WorkSession records the decision          |
| Delivery authority      | Typed owner grant selecting `owner-gated` or `full-in-scope` for one repository     | Product owner grants; `.github` defines meaning; Symphony enforces |

Two similarly named workspaces must remain distinct:

```text
Symphony managed workspace          Workspace Control Plane job workspace

mutable authoring worktree          immutable reconstructed source
survives agent turns/retries        exists for one proof job
holds product changes               receives no authoring authority
cleaned after delivery              destroyed after result capture
```

## Non-negotiable invariants

1. **Facts come from repositories; machinery comes from its runtime owner.** A repository may
   declare an allowed base ref. It must not resolve and persist Symphony's base SHA or implement
   Symphony's worktree lifecycle.
2. **Managed means independently provable.** Symphony may remove a managed workspace only when its
   own durable record and independent Git/filesystem checks prove ownership.
3. **Candidate code cannot grant itself authority.** A candidate worktree cannot change its own
   base SHA, cleanup target, required proof, credentials, or runner trust. The first managed
   allocation pins the WorkSession's repository profile, roots, workspace location, base ref, and
   base SHA; later Attempts reuse that record instead of resolving a candidate-mutable ref.
4. **Operational truth survives process death.** Correctness cannot depend on an in-memory runtime,
   a transport stream follower, or a daemon's retry timer.
5. **Transport identifiers are correlation, not authority.** A runtime task/thread ID or a GitHub
   workflow, job, and check-run ID may identify an invocation; none becomes the Attempt record or
   grants proof authority. WCP admission derives authority from the protected GitHub event,
   enrollment, source, and policy—not from Symphony's correlation fields.
6. **Proof is source-bound.** A green result is meaningful only when it names the exact source,
   accepted adapter, environment, and invocation that produced it.
7. **No copied orchestration.** If adopting another product requires copying worktree, receipt,
   retry, wait, merge, or cleanup code, the owning runtime is incomplete.
8. **No cross-repository big bang.** Compatibility remains until all live resources and consumers
   using it have been identified and drained.
9. **Doctrine is pinned and routed, never copied.** Product repositories point to the canonical
   global principles. Symphony snapshots the exact accepted revision outside the candidate
   workspace; a running attempt never changes doctrine merely because the canonical file advances.
10. **Exceptions are durable decisions.** A deviation from an accepted principle is valid only when
    an authorized human/controller accepts its principle ID and reason into the WorkSession
    decision log. An agent may propose an exception; candidate code and the executing agent cannot
    grant one, edit the doctrine snapshot, or silently weaken the governing rule.
11. **One store, one aggregate root.** WorkSession owns origin, doctrine, decisions, attempts,
    workspace leases, runtime leases, proof correlation, and delivery state in one transactional
    `SymphonyStateStore`; side receipts and issue comments are projections, never competing state.
12. **Concurrent and external mutations are fenced.** Controller assignment and runtime execution
    are distinct. A nonterminal session has one controller assignment; it may have zero or one
    runtime lease. Human/controller edits use the expected WorkSession revision. Runtime,
    workspace, and external-effect operations additionally present the controller generation and
    relevant lease or effect token. A stale process cannot act merely because it once held
    authority.
13. **Managed authoring cannot rewrite its own trust boundary.** Product YAML cannot select a shell
    wrapper, widen Codex writable roots, enable command network, or inherit operator-wide writable
    roots for a managed Attempt. Symphony resolves and directly launches the trusted host runtime,
    supplies the exact per-turn policy, and owns the Attempt-private temp root. Candidate source may
    change worktree files; it may not mutate the trusted source checkout or shared Git metadata.
14. **Product facts and host authority are separate inputs.** A product profile may name product
    identity, an allowed base, accepted authoring context, and preparation needs. It cannot name
    source/state/workspace paths, credentials, runtime binaries, operational limits, or product
    proof. Those belong respectively to an operator-approved Symphony deployment binding and the
    product/WCP proof contract. The deployment binding selects an accepted profile reference but
    cannot rewrite its contents or redefine product proof. Every WorkSession pins the profile,
    resolved context, and binding identities and digests.
15. **Stopped means quiescent before source capture.** Ending a runtime lease requires the managed
    runtime and its descendant processes to be absent. Materialization then holds an exclusive
    workspace fence, captures only Git-source-eligible bytes under a fixed bounded policy, and
    detects concurrent mutation. Runtime caches, ignored artifacts, shared Git metadata, and
    candidate-selected executable Git behavior never enter the source tree.
16. **Dependency declarations do not grant network authority.** A product may select an accepted
    preparation class and lock dependencies by digest. It cannot enable general egress or choose
    reachable host/private endpoints. Symphony applies an operator-owned dependency-egress policy,
    records its digest, and refuses when that boundary is unavailable or a lockfile requires a
    disallowed source.
17. **Recording a checkout does not adopt it.** An interactive human attachment is session-level
    context, not an Attempt workspace lease. Recording it creates no Attempt or runtime lease and
    grants Symphony no reset, clean, dependency-teardown, worktree-removal, materialization, or
    delivery authority over that path.

## Repository outcomes and ownership

### 1. Harness Engineering

**Outcome:** an evidence-backed, retrieval-oriented body of methods that helps reviewers and
builders reason about authority, context, proof, whole-job ownership, durability, and tool
legibility.

**Owns:** general arguments, cases, source provenance, evaluations, review playbooks, guidance for
discovering the semantic owner of a problem, methods for assessing whether a system completes and
proves the whole job, and evidence-backed proposals for new or amended global principles.

**Supplies through a seam:** read-only, just-in-time context selected for an unresolved design or
review question.

**Must not own:** global estate doctrine or board policy; runtime orchestration, repository
profiles, worktrees, proof runners, or product conclusions; a package that Symphony or a product
must fetch during bootstrap.

**Alignment work:** use the existing corpus and review methods to assess the downloaded
`golden-principles.md` proposal and future amendments. Harness Engineering may supply reasoning,
examples, and review procedures, but it does not publish a second normative copy. If this alignment
produces a reusable method, add it only through Harness Engineering's own editorial process.

### 2. Personal `.github` control plane

**Outcome:** one global governance plane defining accepted engineering principles, shared board
semantics, executor labels, authorization vocabulary, workpad convention, and repository onboarding
policy.

**Owns:** the canonical `agent-system/golden-principles.md`, its stable `GP-01`–`GP-20`
identifiers, human exception authority, and amendment process; board topology and the meaning of
shared statuses; the
canonical `driver:direct` and `driver:symphony` labels and the rule that a board-linked item selects
exactly one; the workpad convention; board creation, label synchronization, and board-drift checks;
a short estate boundary map that routes to the owning contracts.

**Supplies through a seam:** tracker facts and a versioned global-doctrine reference. Symphony's
tracker adapter consumes the board and its doctrine resolver snapshots the accepted principles;
repositories and agents route to the prose rather than copying it.

**Must not own:** attempt or workspace records, repository worktrees, or runtime execution;
product-specific build, CI, deployment, or required-check policy; Symphony's delivery algorithm or
Workspace Control Plane's runner construction.

**Required corrections:** `agent-system/onboarding.md` currently says product repositories own
harness implementations, prescribes "the five hooks" (`prepare-workspace`, `before-run`, `prove`,
`after-run`, `remove-workspace`), and `scripts/linked-worktree-delivery.node-test.mjs` locks
repository-owned worktree and delivery mechanics into tests. Replace that split with this ownership
map. Of the five names, four are Symphony lifecycle hooks (`after_create`, `before_run`,
`after_run`, `before_remove` in Symphony's configuration) whose generic implementation moves into
Symphony; `prove` is the product-owned proof entrypoint and stays with the product.

The file currently at `/mnt/c/Users/reini/Downloads/golden-principles.md` is an input proposal, not
authority merely because its header says `Status: normative`. Review it in parallel with Symphony's
foundation work and land only the accepted form at
`~/.github/agent-system/golden-principles.md`. Rename its global citations to `GP-01`–`GP-20` so
they cannot collide with product-local identifiers such as Dyslexify's G1–G4. Before adoption,
revise GP-15 so an agent's visible universe includes automatically supplied, version-pinned global
doctrine as well as repository-local truth. Narrow claims such as queues at every seam or mandatory
vendoring unless estate evidence supports them. Its enforcement map must distinguish existing from
planned mechanisms, name the owning repository for each mechanism, and state that an agent may
propose but only an authorized human/controller may accept an exception.

### 3. Workspace Repo Template

**Outcome:** a new product repository begins with a clear charter, local architecture, product
proof skeleton, and thin declarations for Symphony and Workspace Control Plane.

**Owns:** the initial shape of repository-local truth; examples of product tests and
product-specific proof aggregation; thin adapter examples pinned to accepted owner-defined schemas;
an enforcement register that distinguishes mechanical checks from review rules.

**Supplies through a seam:** files copied once when a repository is created. After creation, the
product repository owns those files; the template is not a runtime dependency.

**Consumes:** the repository-profile schema owned by Symphony, the proof-adapter schema owned by
Workspace Control Plane, and a thin routing reference to the canonical `.github` doctrine.

**Must not own:** Git worktree creation/removal, immutable base selection, lifecycle receipts,
dependency cleanup, retries, CI polling, merge coordination, or runner provisioning; a second
implementation of Symphony or Workspace Control Plane; machine-specific source or worktree paths.

**Required correction:** `scripts/harness/` currently ships `workspace.mjs`, `_receipt.mjs`,
`install-artifacts.mjs`, `prepare-workspace.mjs`, `remove-workspace.mjs`, `tree-fingerprint.mjs`,
and their tests — a complete generic lifecycle implementation. Remove it after the Symphony
replacement exists. Retain only an intentionally product-shaped `prove.mjs` example. Generic
profile, doctrine-routing, proof-adapter, and enforcement-register validators move to their owning
systems instead of being copied into generated repositories: Symphony validates repository
profiles, `.github` validates doctrine/board routing, and WCP validates protected proof adapters.
Template tests validate the generated shape in the template repository itself.

### 4. Symphony

**Outcome:** one durable authoring and delivery substrate whose WorkSessions may originate from a
tracker now or explicit human initiation later without introducing a second state system.

**Owns:** the `WorkSession` aggregate and transactional `SymphonyStateStore`; child attempt,
runtime-lease, workspace-lease, source-materialization, proof-correlation, and delivery state; the
trusted repository-profile schema, accepted profile/context snapshot, and digests; the
Symphony-managed repository lifecycle and its preparation drivers; the agent runtime port and the
direct Codex provider; pull-request, immutable-head, CI-wait, outcome-classification, merge, and
cleanup coordination; the applied doctrine snapshot and durable exception/decision log; workpad
projection for tracker items.

**Supplies through seams:** a tracker controller that consumes `.github` board facts; repository
and runtime provider ports; and an immutable delivered PR head whose protected GitHub required check
can be correlated to Workspace Control Plane evidence.

**Consumes:** product facts from a trusted repository profile; the accepted global-doctrine
reference, global board semantics, and tracker data; runtime events from Codex; source-bound proof
outcomes from Workspace Control Plane.

**Must not own:** product semantics, domain tests, or the meaning of product correctness; the
canonical global principles or board doctrine; GARM, Incus, runner images, privileged credentials,
or proof-compute construction; general Harness Engineering doctrine.

**Required correction at plan approval:** the hook-based `workspace.provider: harness` path remains
a compatibility driver only. The committed orchestrator held all operational state in memory
(`src/orchestrator/orchestrator.ts`, `#running`, `#retries`, `#claimed`) and documents restart
recovery as "tracker- and filesystem-derived"; the only durable Symphony-owned record is the
fresh-attempt receipt under `<workspace.root>/.symphony/`. Replace that split with a single
transactional SQLite-backed `SymphonyStateStore` under the configured state root. `WorkSession` is
the aggregate root; tracker issues are one origin variant, not required fields on every attempt.
SQLite transactions also own external-effect intents and fencing generations, avoiding a second
file-record model when the manual controller arrives.

**Relationship to `SPEC.md`:** the specification's fresh-attempt extension (9.3.1) already carries a
compatibility note pointing at the driver boundary. Each phase that changes normative behavior
revises the specification together with the implementation, never ahead of it.

### Separate: A2A Fleet retirement candidate

**Recommendation:** retire through a separately authorized archival runbook. Symphony already
contains a direct Codex app-server provider
(`src/agent/app-server-client.ts`, `process-transport.ts`, `runner.ts`); no pilot names a runtime
that needs a non-native transport. Re-open only if a named pilot needs one, and then as a narrow
provider behind Symphony's runtime port, never as a scheduler or worktree owner.

**What would be retained:** the integration findings in `a2a-fleet/docs/DESIGN.md`. Nothing from
`dispatch/` or `worker/` is required by this alignment or integrated into Symphony.

**Inventory recorded for the retirement (verified 2026-08-25):**

| Resource                                       | Finding                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/a2a-fleet` checkout                         | 816 KB, 8 commits on `master`, clean, with no configured remote; absence of an external copy is not proven                                                         |
| `~/.a2a-fleet/fleet.db`                        | 44 KB SQLite, mode 0644, tables `lanes`, `queue`, `tasks` (11 tasks), including task prompts; any archive must be private                                          |
| `~/.a2a-fleet/worktrees/` (10 entries)         | 9 are worktrees of a scratchpad `probe-repo` whose parent no longer exists (dangling directories); 1 is a registered worktree of `~/ws-dyslexify`                  |
| `~/.a2a-fleet/worktrees/3dd39d1a-…`            | branch `a2a/3dd39d1a`, local only, already merged into `ws-dyslexify` `main`; two untracked probe artifacts mean ordinary `git worktree remove` refuses            |
| Running processes, systemd units, cron entries | none                                                                                                                                                               |
| References elsewhere                           | one row in `~/.github/agent-system/worktree-estate.md` (line 134) describing the A2A worktree path; nothing in Symphony, WCP, the template, or Harness Engineering |

### 5. Workspace Control Plane

**Outcome:** trusted, source-bound proof runs in disposable, isolated compute with bounded identity,
capacity, credentials, and cleanup.

**Owns:** fleet enrollment, authorities, capacity, exemptions, and runner registry; GARM/Incus
construction, images, host locks, callbacks, credentials, and cleanup; protected proof planning,
admission, execution, final-gate publication, and immutable proof-result contracts; the generic
proof-job sequence inside a disposable VM; source/environment/result correlation and isolation
evidence. It also owns the estate's existing narrow doctrine-publication mechanism: a deterministic
manifest-driven bridge that generates digest-bound pointers from `.github` canonical sources while
neither interpreting nor authoring doctrine.

**Supplies through a seam:** an admitted proof result bound to source SHA, accepted adapter digest,
runner/image identity, attempt, and captured output.

**Consumes:** a reviewed fleet entry; a protected, hash-pinned product proof adapter; an immutable
source revision and bounded proof request.

**Must not own:** product test meaning, product delivery policy, board polling, attempt records,
authoring worktrees, agent planning, or PR review decisions.

**Current accepted infrastructure state (verified at WCP `3628446` on 2026-08-25):** Dyslexify is
a GitHub-backed, enabled capacity-one GARM/Incus declaration with an owner-specific App, provider,
repository, max-one pool, and disconnected/readiness evidence. WCP's own canary document still says
`Activation source awaiting live proof`. This establishes a reviewed boundary ready for a bounded
canary; it does not prove the connected runner lifecycle, repair the v1 proof trust model below, or
establish Symphony integration.

**Required correction:** v1 is advisory because its pinned JSON can still invoke a
candidate-controlled `.workspace-ci/run.mjs`, which can no-op product proof, and its result protocol
collapses `setup_refused` and `non_verdict`. Build v2 as protected base policy plus exact base/head
diff → canonical proof plan and digest → protected admission → isolated candidate execution →
authenticated result parser and final gate. Candidate changes may widen but never reduce the
protected floor. Keep a separate full-regression lane independent of affected selection. Reuse the
existing max-one boundary for a v2 hostile no-op and teardown canary before the Dyslexify pilot;
do not add capacity merely to prove the new contract.

**Transport decision after current-state review:** use the existing GitHub/GARM path. Symphony
materializes and pushes one immutable head, GitHub supplies the protected event and required-check
surface, and WCP plans/executes/publishes the source-bound result on the existing max-one runner
boundary. Do not add a direct Symphony proof transport and do not relabel Dyslexify as `local`.
Transport code may allocate execution, but it may not classify the diff, weaken lanes, parse its
own untrusted result, or decide the final verdict.

### Consumers: product repositories

**Outcome:** a product can be authored by Symphony and proven through the accepted contracts without
containing infrastructure machinery.

**Own:** product code, domain model, invariants, tests, architecture, and decisions; manifests and
lockfiles; the canonical product proof entrypoint and required-check policy; the owner-accepted
delivery-authority selection; thin repository and proof declarations; product-specific prompt
context that grants no orchestration authority.

**Consume:** the accepted `.github` doctrine by versioned reference; Symphony authoring services
through a thin repository profile; Workspace Control Plane proof through a thin accepted adapter.

**Live consumers of the legacy contract (verified 2026-08-25):** three repositories run
`workspace.provider: harness` with the copied `scripts/harness/` lifecycle today:

| Repository                                                                                               | Board | `scripts/harness/` files | Of which Symphony copies | Notes                                                                           |
| -------------------------------------------------------------------------------------------------------- | ----- | ------------------------ | ------------------------ | ------------------------------------------------------------------------------- |
| Dyslexify (`reinispilens/dyslexify`, `~/ws-dyslexify`)                                                   | #4    | 84                       | 12                       | pilot, Phase 8; WCP v1 adapter pinned; max-one pool enabled, live proof pending |
| Storefronts (`agentic-ecommerce-platform/storefronts`, `ws-agentic-ecommerce-platform/storefront-faces`) | #29   | 14                       | 11                       | `fresh_attempt_states: [Rework]` enabled                                        |
| Project Tracker (`reinispilens/project-tracker`, `~/ws-project-tracker`)                                 | #3    | 8                        | 5                        | hooks invoked as `pnpm harness:*` aliases                                       |

Dyslexify is the pilot (Phase 8). Storefronts and Project Tracker migrate afterwards through the
same procedure before compatibility removal. `core` (board #28), `platform-infra` (board #30), and
`market-intelligence` have no Symphony workflow; any onboarding is a follow-on product decision.
The full per-repository bill of change is in the
[consumer estate section](#consumer-estate-and-per-repository-bill-of-change).

**Must not own:** Symphony worktrees, receipts, attempts, retries, delivery polling, or cleanup;
runner construction, privileged credentials, or proof trust selection; copies of global doctrine or
Harness Engineering conclusions. Product-specific architecture decisions remain local and may cite
an accepted global principle or a durable exception without reproducing the principle text.

## Consumer estate and per-repository bill of change

Surveyed 2026-08-25 across every Git repository under `~/ws-*` (twelve repositories, two of them
nested workspaces). Every aligned consumer ends in the same thin shape inside the repository — a
small repository profile (Seam C), one hash-pinned Workspace Control Plane proof adapter (Seam F),
and three routing lines in `AGENTS.md` that replace the hook table. The profile never repeats the
proof command or claims; WCP's accepted adapter/policy is the sole machine-readable protected proof
binding. A migration adds only the pieces it lacks; for example, Dyslexify already has its WCP
adapter. Outside the repository, its board receives one `driverRouting: true` line in
`~/.github/agent-system/board-projects.mjs` and a label audit. Only Bucket 1 deletes anything.

```text
 BUCKET 1  migrate                BUCKET 2  onboard on the new profile     out of scope
 delete copies, add the three     add the three, delete nothing            Bucket 3: not onboarded
 ───────────────────────────      ───────────────────────────────────      Bucket 4: not a product
 dyslexify        Phase 8         core                    follow-on decision
 storefronts      post-pilot      market-intelligence     follow-on decision
 project-tracker  post-pilot      platform-infra          follow-on decision
```

### Bucket 1: live legacy consumers — migrate

| Repository          | Today                                                                                                                    | Delete                                                                                         | Add                                       | Decide first                                                           | Size |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- | ---- |
| **Dyslexify**       | `provider: harness`, 3 hooks, 84 `scripts/harness/` files, WCP v1 adapter plus enabled max-one pool (live proof pending) | 12 Symphony copies; the hook lines in `WORKFLOW.md`                                            | profile, `AGENTS.md` routing              | reclassify the five open harness issues (#284, #292, #320, #330, #358) | M    |
| **Storefronts**     | `provider: harness`, 4 hooks, `fresh_attempt_states: [Rework]`, 14 `scripts/harness/` files                              | 11 lifecycle copies; retain only product-specific proof                                        | profile, WCP adapter, `AGENTS.md` routing | none                                                                   | S    |
| **Project Tracker** | `provider: harness`, 4 hooks invoked as `pnpm harness:*`, 8 `scripts/harness/` files                                     | 5 copies plus the four `harness:prepare/before-run/after-run/remove` aliases in `package.json` | profile, WCP adapter, `AGENTS.md` routing | none                                                                   | S    |

Twenty-eight files are deleted across the three repositories; that is the entire cleanup this plan
performs in the product estate. What stays in every case is the product's own proof: `prove.mjs`
and the `check-*` scripts and tests beside it.

### Bucket 2: onboarded to the org system but not on Symphony — add only

| Repository              | Today                                                                                                        | Delete  | Add                                                                           | Decide first                                                                                                                                                         | Size                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **core**                | board #28, `AGENTS.md`/`CLAUDE.md`, 11 CI workflows on self-hosted runners, WCP entry observed at capacity 0 | nothing | profile, WCP adapter, `AGENTS.md` routing, `driverRouting` on #28             | which single command is Core's verdict and which checks are authoritative — a Core decision recorded in Core, since Symphony cannot wait on a check nobody has named | S in the repo; M to decide |
| **market-intelligence** | `AGENTS.md`/`CLAUDE.md`, registered in `BOARDS` with no board created, CI is operational heartbeats          | nothing | a real `prove` entrypoint, board via `create-board.mjs`, profile, WCP adapter | what "proven" means for this product; today there is no proof, only monitoring                                                                                       | M                          |
| **platform-infra**      | board #30 already `driverRouting`, `AGENTS.md`/`CLAUDE.md`, no `package.json` (backup/box/ci/deploy)         | nothing | optional: profile plus a non-pnpm `prove` form                                | whether Symphony should author infrastructure at all; default is no, it stays `driver:direct` with no profile                                                        | 0–S                        |

Bucket 2 repositories never adopt the legacy hooks. They may onboard only after the profile schema
and thin template exist, through a separate product decision.

### Out of scope for this plan

Bucket 3 — `ad-intelligence` (Python, no `AGENTS.md`, no board, no CI, an
`ad-intelligence-archive-20260825` sibling suggests it is being archived), `knowledge-cartographer`
(Python, remote named `reinispilens/45-agentic-systems`, last commit July), `twentyfirst-local` and
`worklfows-reverse-spec` (no Git remote, so no board can exist). Each needs an owner decision —
archive, push, or onboard — before any plan applies; none is scheduled here.

Bucket 4 — `ws-gpu-platform` (not a Git repository), `ws-enterprise-ai` (a zip file),
`org-github` and its archive (the organisation `.github` repository: reusable CI, not a product),
and `storefront-factory` (no Git repository). Not products; nothing to do.

## State and authority map

Every durable fact needs one canonical owner. Projections may improve visibility, but they may not
quietly become a second writer.

| Fact or state                        | Canonical owner                                                                        | Permitted projection                                |
| ------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| General review methodology           | Harness Engineering                                                                    | Links from target guidance                          |
| Accepted engineering principles      | `.github/agent-system/golden-principles.md`                                            | Versioned routes; never copied principle text       |
| Accepted tracker policy              | `.github` machine-readable board/driver policy                                         | Symphony WorkSession reference and digest           |
| Applied doctrine revision            | Symphony WorkSession record                                                            | Prompt metadata and workpad summary                 |
| Principle exception decisions        | Symphony decision log under the pinned doctrine revision                               | Issue workpad or CLI status summary                 |
| Global status and driver semantics   | `.github`                                                                              | Repository routing links and Symphony configuration |
| Work authorization                   | GitHub Project status for tracker origin; explicit human grant for interactive origin  | Symphony origin/controller snapshot                 |
| Product truth and proof meaning      | Product repository                                                                     | Prompt context and proof receipt description        |
| Product profile and context snapshot | Symphony WorkSession record of accepted product revision and resolved content digests  | Status/workpad identity only                        |
| Host deployment binding              | Symphony operator configuration and accepted product-profile reference                 | WorkSession binding identity/digest                 |
| WorkSession and child attempt state  | SymphonyStateStore                                                                     | Runtime snapshot, issue workpad summary             |
| Managed workspace ownership          | Symphony workspace lease plus independent Git/filesystem state                         | Logs and operator status                            |
| Human checkout ownership             | Human/external tool; Symphony stores only a non-removable WorkSession attachment       | CLI/status reference                                |
| Controller assignment                | SymphonyStateStore generation                                                          | CLI/status and optional workpad summary             |
| Runtime execution lease              | SymphonyStateStore fenced lease                                                        | Codex thread/turn identifiers as correlation        |
| Materialization intent/correlation   | Symphony source-materialization saga; Git object store holds resulting immutable bytes | Branch/head and delivery record                     |
| Protected proof result               | Workspace Control Plane                                                                | GitHub check and Symphony delivery record           |
| Pull request and merge truth         | Git hosting provider                                                                   | Symphony delivery record and workpad summary        |
| Delivery-authority grant             | Product owner through an accepted product-profile revision                             | WorkSession grant plus governing-policy digest      |
| Runner capacity and credentials      | Workspace Control Plane                                                                | Availability/result facts exposed to Symphony       |

## Required seams

### Seam A: methodology retrieval

Read target-local truth first; if a question stays unresolved, select one Harness Engineering route
and apply the method without copying its repository shape. This is a human/agent reading seam, not a
package or runtime API.

### Seam B: global doctrine and tracker facts

`.github` defines the accepted engineering principles, board vocabulary, driver labels, and
delivery-authority vocabulary. Harness Engineering may propose or substantiate a principle, but
acceptance, exception authority, and amendment happen in `.github`. Repository onboarding and the
Workspace Repo Template route to the canonical sources; they do not copy principle text, status
descriptions, or lifecycle algorithms into each product.

The prose doctrine and Symphony's machine input must not become two independently edited versions
of the board contract. Phase 6a publishes one small, versioned tracker-policy value covering active,
inactive, terminal, fresh-attempt, failure-target, and driver-selector semantics; `.github` tools
and Symphony consume or validate against that same value. Its portable identity is repository,
path, revision, and digest. The current deployment-binding v1 fields that repeat these values are an
explicit compatibility projection only until Phase 6b, not the final ownership seam.

Symphony has two read-only consumers of this seam. Its tracker adapter reads live item facts, applies
the pinned tracker policy, and fails closed on missing or conflicting driver labels. Its governance
resolver consumes operator-approved sources for the tracker policy and
`agent-system/golden-principles.md`, verifies their configured repository revisions and content
digests, and writes those immutable references to the WorkSession before work starts. An amendment
governs new sessions; existing sessions retain their pinned revisions. A later governance-rebase
operation is deliberately out of the MVP. An agent may propose `EXCEPTION GP-xx: <reason>`, but only
an authorized human/controller can append the accepted exception.

For tracker-origin sessions, `.github` defines one structured Human Review/workpad action for that
acceptance. Symphony verifies the GitHub actor against the repository's accepted human authority;
the executing bot/agent cannot accept its own comment. For interactive-origin sessions, the local
human controller uses the companion plan's fenced `steer` operation. Both routes call the same
WorkSession decision operation and preserve the actor, doctrine revision, principle ID, reason, and
expected WorkSession revision.

Workspace Control Plane retains the existing deterministic publication bridge described by
`docs/architecture/doctrine-publication.md`. The bridge consumes `.github` owners, renders pointer
files and digest locks in owner `.github` repositories, and proves deterministic output. It does
not select, interpret, amend, or enforce the doctrine. The golden-principles route is added to its
manifest once the `.github` owner publishes the accepted file.

The accepted wording of GP-15 must reflect this seam: repository-local truth and automatically
supplied, version-pinned global doctrine are both durable visible context. A machine-local path such
as `~/.github/...` may locate the checkout, but the recorded identity must be portable—a repository
identity, path, revision, and content digest—not merely that path.

### Seam C: trusted repository profile

This seam has two inputs because product facts and host authority have different owners. Symphony
owns and versions both schemas and composes them only after independent validation.

```text
product profile, versioned with trusted product truth:
  repository identity + allowed base ref
  accepted authoring-context routes
  preparation class required by the product
  typed delivery-authority grant accepted from the product owner

Symphony deployment binding, outside the product repository:
  accepted profile repository + path + revision + digest
  trusted source checkout path
  state root + managed workspace root
  repository branch namespace
  exact Git executable
  tracker repository/project coordinates + accepted tracker-policy reference
  credential source names
  Codex executable source + runtime limits
```

The template ships only an example product declaration. It never emits the deployment binding.
The binding selects a portable accepted profile reference; Symphony reads that exact Git revision,
verifies its digest, and resolves the named authoring context from the same revision rather than
from mutable candidate files. This breaks the bootstrap cycle: an arbitrary working-tree profile
cannot choose the base against which it will be trusted. Candidate-local instructions may be
visible as source, but they are not authoritative configuration and cannot change permissions,
roots, proof, or delivery policy.

Conversely, deployment configuration cannot alter the accepted profile bytes or redefine product
proof meaning. Symphony snapshots the accepted profile revision/digest, resolved context manifest
and digests, and deployment-binding identity/digest before the first Attempt, then records them on
the WorkSession. A candidate cannot select a workspace/state root, runtime executable, credential
source, or weaker limits by editing its repository. A deployment operator can select a different
accepted profile revision only as an explicit new binding/revision, never as an invisible live
substitution beneath an active WorkSession.

### Seam D: one durable state store and workspace ownership

Symphony keeps one SQLite-backed `SymphonyStateStore` outside every product checkout and candidate
workspace, under the configured state root. A WorkSession is the transaction root:

```text
WorkSession
├── origin: tracker | interactive
├── pinned doctrine + accepted decisions
├── accepted product profile/context + deployment binding
├── controller assignment generation
├── 0..1 human-owned attachment (interactive only; never a lease)
├── 0..n Attempts
│   ├── 0..1 fenced runtime lease
│   └── 0..1 managed or compatibility workspace lease
├── proof correlations
└── source-materialization + delivery saga + external-effect intents
```

Schema migrations are versioned and transactional. Side receipts may remain during compatibility,
but they are projections and cleanup evidence, never a second state store. Controller assignment
(who may decide) is distinct from a runtime lease (who is executing now). Human/controller edits
use the expected WorkSession revision; controller-bound runtime, workspace, and external-effect
operations additionally use the current fencing generation.

The workspace port represents ownership explicitly:

| Mode          | Created by                      | May Symphony modify?           | May Symphony remove?                 |
| ------------- | ------------------------------- | ------------------------------ | ------------------------------------ |
| `managed`     | Symphony RepositoryDriver       | Yes, under the active attempt  | Only after guarded proof             |
| `legacy-hook` | Existing compatibility consumer | Through compatibility behavior | Only through legacy refusal contract |

The companion plan adds a session-level human attachment, not another RepositoryDriver mode. It is
validated and recorded by the WorkSession application service without creating an Attempt or
runtime lease. RepositoryDriver cleanup accepts only its managed/compatibility lease union, so an
attachment is mechanically unrepresentable as a cleanup target.

### Seam E: agent runtime provider

Symphony owns the attempt and supplies an already-authorized working directory, prompt, environment
policy, correlation ID, cancellation boundary, and event sink. A provider returns normalized events
and a terminal result. The direct Codex app-server provider is the only implementation; the port
exists so that a future provider cannot allocate a worktree, select work, claim a board item, or
decide delivery.

For a managed workspace, “environment policy” is an enforced value, not a product option. The
operator binding pins exact Codex, `systemd-run`, and `systemctl` executables outside
source/state/workspace roots. Symphony launches `codex app-server` without a login shell, fixes
approval to `never`, and sends an exact `workspaceWrite` policy on every turn. Network, `/tmp`,
inherited `TMPDIR`, and extra writable roots are excluded. One fenced state-root runtime temp is the
only extra writable root. The app server and descendants run in a deterministic systemd user scope;
Symphony proves that cgroup empty before sweeping temp state or releasing/expiring the runtime lease.
Compatibility modes retain their existing command pass-through until drained; that exception is not
a template for new repos.

### Seam F: product proof and protected execution

The product owns one canonical proof entrypoint and the claims it establishes. The accepted WCP
adapter/policy is the sole machine-readable protected binding of those product facts to lanes and
change classes; the Symphony repository profile does not repeat them. Workspace Control Plane owns
protected planning, admission, and execution. Symphony owns orchestration and correlation: it sends
one immutable branch/PR head through delivery, then records the GitHub check/run, adapter/policy,
plan, source, and evidence identities WCP published. WorkSession and Attempt IDs remain Symphony
correlation only; they do not authorize the GitHub job or need to cross into candidate execution.

```text
product repository        Symphony + GitHub            Workspace Control Plane

proof meaning +       immutable PR head/check          admission + isolated run
accepted entrypoint ─────────────────────────────────▶ exact source + adapter digest
                              ◀──────────────────────── proof result + evidence
```

The v2 path is explicit:

```text
protected base policy + immutable base/head diff
                    ↓
       canonical affected plan + digest
                    ↓
            protected admission
                    ↓
 isolated candidate execution in a fresh VM
                    ↓
 authenticated lane results + protected final gate

manual/nightly ──► independent full regression
```

Candidate changes may add proof but cannot lower the base-owned floor, replace the planner or
parser, write protected result channels, select a weaker runner, or make a no-op wrapper
authoritative. Product outcomes retain their four-way semantics: `passed`, `failed`,
`setup_refused`, and `non_verdict`.

### Seam G: delivery

The managed authoring sandbox intentionally cannot update shared Git metadata or use delivery
credentials. Ending its runtime lease first proves the app server and all attempt-owned descendant
processes are gone. Symphony then takes an exclusive workspace fence and its trusted materializer
creates one immutable tree/commit from the working tree against the pinned parent. A fixed,
versioned inclusion policy captures tracked changes, deletions, and bounded non-ignored untracked
source while excluding `.git`, ignored/runtime/cache artifacts, and anything outside the worktree.
Two-pass manifests or an equivalently strong snapshot mechanism detect concurrent mutation.

The materializer uses a Symphony-owned temporary index and a reviewed Git configuration that
executes no hooks, signing helpers, credential helpers, or candidate-selected filter drivers. An
unsupported file mode, nested repository/submodule transition, filter requirement, oversized or
ambiguous source set, or changing workspace is a refusal, not a fallback to ordinary `git commit`.
The materialization intent, input parent, inclusion-policy digest, input manifest, resulting tree,
commit, and atomic expected-old branch update are durable before remote delivery begins.

Symphony then records the branch, PR, immutable head SHA, required checks, proof result, merge
result, and cleanup state, and waits on external checks as durable state rather than sleeping agent
turns. Git hosting remains authoritative for remote PR and merge facts. Push, merge, and release
authority come from the recorded delivery authority profile (`owner-gated` or `full-in-scope` under
`.github` doctrine), never from the fact that Symphony is running the attempt.

The product owner selects that profile in the accepted product-profile revision; candidate edits
cannot change an existing WorkSession's grant. `.github` owns the two values and their semantics,
the WorkSession pins both the selected value and governing policy digest, and an operator-owned
delivery provider holds credentials and executes only operations the typed grant and current board
state permit. `owner-gated` may materialize, push, and open a PR but stops at Human Review;
`full-in-scope` still cannot operate outside the named repository/outcome or bypass protected proof.

## Required journeys

### Journey 1: tracker-controlled attempt

```text
human authorizes board item + driver:symphony
        │
        ▼
Symphony pins binding + product context + doctrine and creates/recovers the WorkSession
        │
        ▼
RepositoryDriver creates the managed workspace and its record
        │
        ▼
agent edits files under a fenced runtime lease
        │
        ▼
trusted tree/commit materialization → exact push/PR → protected WCP check → Human Review/merge
        │
        ▼
verified terminal cleanup, records marked removed
```

Acceptance requires that a daemon restart at any point resumes from the records without a second
claim, a second worktree, or a lost attempt.

### Journey 2: common protected proof

Symphony materializes and pushes one immutable source/PR head. The protected GitHub caller admits
that exact base/head to Workspace Control Plane, which reconstructs it in a disposable environment,
publishes source-bound evidence as the required check, and cleans the proof environment. Symphony
correlates that check/result to the Attempt; it does not treat an unrelated green run as proof.

## Baseline gap register

The `EG` prefix means **estate gap**. It deliberately does not use the golden principles' permanent
`GP-01`–`GP-20` citation namespace. These conditions describe the committed estate when the plan
was approved. The local checkpoint above records candidate repairs without pretending they are
already merged or adopted; in particular, EG1 and EG2 have local Symphony implementations but are
not closed estate-wide yet.

| ID   | Current condition                                                                                                                | Boundary problem                                                                                                               | Repair owner                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| EG1  | Symphony holds attempt state in memory; the only durable Symphony record is the fresh-attempt receipt                            | Recovery and cleanup authority depend on tracker state and hook code                                                           | Symphony                                                                                                                          |
| EG2  | Symphony's `workspace.provider: harness` delegates generic lifecycle to four repository hooks                                    | Reusable privileged machinery is distributed to consumers                                                                      | Symphony                                                                                                                          |
| EG3  | `.github` onboarding says product repositories own harness mechanisms and prescribes the five hook scripts                       | Global onboarding actively reproduces the wrong boundary                                                                       | `.github`, after Symphony contracts stabilize                                                                                     |
| EG4  | Workspace Repo Template ships worktree, receipt, install-artifact, and lifecycle code with tests                                 | Every new repository becomes another orchestration implementation                                                              | Template, after central replacement                                                                                               |
| EG5  | Workspace Repo Template does not seed the WCP proof adapter                                                                      | New repositories lack the intended protected-proof seam                                                                        | Template + WCP contract                                                                                                           |
| EG6  | A2A Fleet has its own dispatcher store, worktrees, and DB/merge lanes; frozen, unpublished, no tests                             | It duplicates Symphony scheduling and workspace responsibilities                                                               | Separate retirement decision                                                                                                      |
| EG7  | WCP v1 pins an adapter but delegates its verdict to candidate-controlled `.workspace-ci/run.mjs` and collapses product outcomes  | A candidate can no-op its judge; result semantics lose refusal/non-verdict                                                     | WCP protected proof v2 before pilot                                                                                               |
| EG8  | Dyslexify carries compatibility harness machinery and five open harness issues (#284, #292, #320, #330, #358) as of 2026-08-25   | The pilot is under active pressure to keep building consumer-side infrastructure                                               | Symphony replacement first; Dyslexify migration last                                                                              |
| EG9  | The Dyslexify (#4), Storefronts (#29), and Project Tracker (#3) boards are registered in `.github` without `driverRouting: true` | Exactly-one-driver labels are not centrally checked on any live consumer                                                       | `.github`, through separately authorized board audit                                                                              |
| EG10 | The downloaded golden-principles proposal claims normative enforcement but has no accepted governance home or pinned consumer    | Policy could drift, conflict with GP-15, or claim mechanisms that do not exist                                                 | `.github`, informed by Harness Engineering                                                                                        |
| EG11 | WCP's existing deterministic doctrine-publication bridge is absent from the topology                                             | An operating cross-repo seam has no stated owner or retirement decision                                                        | Retain explicitly in WCP; `.github` owns content                                                                                  |
| EG12 | The template generates generic workflow and enforcement validators alongside lifecycle scripts                                   | Common policy is still copied even after worktrees move into Symphony                                                          | Owning systems validate; template tests shape only                                                                                |
| EG13 | WCP now has an enabled max-one GitHub/GARM Dyslexify declaration with live proof pending and a v1 candidate-controlled adapter   | Readiness could be mistaken for a completed lifecycle or authoritative proof, or prompt a needless second transport            | WCP Phase 4 proves live v2 on that boundary; Symphony adds no direct transport                                                    |
| EG14 | Managed workflow YAML can select a shell command and Codex sandbox overrides; user config can add estate-wide writable roots     | Candidate authoring can escape the worktree boundary, leave mutating descendants, or change trusted source/shared Git metadata | Symphony Phase 2 owns direct launch, exact sandbox policy, and process quiescence                                                 |
| EG15 | The agent is described as creating a PR even though managed mode withholds Git-ref and delivery authority                        | No trusted seam converts edited worktree bytes into the immutable head required by proof and delivery                          | Symphony Phase 5 adds durable source materialization before remote delivery                                                       |
| EG16 | Product `WORKFLOW.md` still mixes product facts with absolute workspace roots and runtime/host settings                          | A thin adapter can choose host topology and operational authority during initial daemon configuration                          | Symphony Phase 2 splits the product profile from an operator-owned deployment binding                                             |
| EG17 | Committed legacy preparation can share unrestricted host networking                                                              | Candidate dependency declarations can reach host/private services or arbitrary lockfile destinations without credentials       | Symphony Phase 3 owns restricted dependency egress and fail-closed/offline behavior; the local candidate takes the offline branch |

The former gap "`.github` describes the board as the only conversation" is real but belongs to the
interactive control plan, because it only becomes a boundary problem once boardless work exists.

## Migration strategy

The governing sequence is one state foundation, capability first, protected proof before a real
consumer, and deletion only after replacement evidence. Golden-principles review and the decision
to retain WCP's narrow publication bridge run alongside the Symphony foundation; doctrine must be
accepted before the Dyslexify pilot, not before local state-model work can begin.

```text
freeze new copies ───────┬──── review golden principles
                         └──── retain/record doctrine-publication owner
      │
      ▼
one WorkSession model + SymphonyStateStore
      │
      ▼
RepositoryDriver + guarded Git worktrees
      │
      ▼
unprivileged preparation
      │
      ▼
WCP protected proof v2 + capacity-one canary
      │
      ▼
durable delivery correlation
      │
      ▼
.github doctrine rewrite
      │
      ▼
Symphony accepted-doctrine resolver
      │
      ▼
thin template
      │
      ▼
Dyslexify autonomous pilot
      │
      ▼
manual MVP: start · attach · plan · steer · status

later: controller handoff
after pilot: Storefronts + Project Tracker compatibility drain
separate decisions: A2A retirement and other product onboarding
```

Every phase must be independently releasable. A later repository must not be modified merely to
make an earlier phase appear complete.

### Phase 0: freeze and establish baselines

**Repositories:** all, with documentation-only changes where authorized.

1. Declare the current template lifecycle and Symphony harness provider transitional (Symphony's
   `SPEC.md`, `WORKFLOW.example.md`, and `docs/conformance.md` already carry this note).
2. Stop creating new product-owned Symphony lifecycle implementations.
3. In parallel, review
   `/mnt/c/Users/reini/Downloads/golden-principles.md` using Harness Engineering's evidence and
   methods; rename global IDs to `GP-01`–`GP-20`; revise GP-15 for version-pinned global context;
   narrow unsupported universal claims; define human exception authority; audit every claimed
   mechanism; and publish the accepted text once as `agent-system/golden-principles.md`. Until that
   change lands, the downloaded file is candidate input only. Land this narrow GH0 publication
   change and return the `.github` checkout to a clean state before Phase 4: Workspace Control
   Plane's own repository instructions prohibit WCP edits while its doctrine source checkout is
   dirty.
4. Record the doctrine-publication decision: `.github` owns content and acceptance; WCP retains its
   deterministic pointer/digest bridge. WCP adds golden principles to its own manifest in Phase 4,
   only after acceptance.
5. Verify that Harness Engineering's own authority statement says it supplies evidence and review
   methods, not global doctrine or runtime machinery. If that statement is absent, add only that
   boundary through Harness Engineering's own editorial process; introduce no runtime dependency.
6. Freeze WCP at its currently accepted max-one Dyslexify declaration: do not expand capacity,
   treat any v1 output as advisory, and make no second direct transport. The pending connected
   canary and any pool activation/disablement remain WCP operational decisions; this plan does not
   silently mutate them.
7. Inventory every repository currently using the four-hook compatibility contract — today
   Dyslexify, Storefronts, and Project Tracker — including live worktrees under `~/worktrees/…` and
   receipt versions, and list Dyslexify's open harness issues by number so Phase 8 can reclassify
   them.
8. Record clean baselines and repository-specific verification commands before changing behavior.
9. Mark generic generated validators as transitional along with lifecycle hooks; no new repository
   may copy them while their owning checks are centralized.

**Exit:** no new consumer adopts or extends the legacy lifecycle, the publication owner is explicit,
and golden-principles review has an owner and acceptance path. Symphony Phases 1–3 may proceed while
GH0 is under review, but the accepted GH0 change must be landed and the `.github` checkout clean
before any Phase 4 WCP edit. The broader onboarding/doctrine rewrite remains Phase 6a.

### Phase 1: one WorkSession model and state store

**Repository:** Symphony.

1. Add the `WorkSession` aggregate with `origin: tracker | interactive`. Implement tracker origin
   first; interactive is a valid but not yet user-creatable variant.
2. Make doctrine snapshot, accepted product-profile/context and deployment-binding references,
   controller assignment, decision log, optional session-level human attachment, attempts, runtime
   leases, managed/compatibility workspace leases, source materialization, proof correlations,
   delivery state, and external-effect intents children of that root. A human attachment is not an
   Attempt lease. Phase 1 establishes the common schema; Phases 2, 4, 5, and 9 populate the later
   boundaries.
3. Add one `SymphonyStateStore` port and one SQLite implementation under the configured state root,
   using the pinned stable `better-sqlite3` binding. Node 22's built-in SQLite remains experimental
   and emits a startup warning, so it is not the production dependency. Use foreign keys, WAL,
   explicit transactions, schema migrations, integrity checks, bounded busy handling, and a
   supported backup procedure.
4. Separate three concurrency concepts: the WorkSession revision for optimistic human/controller
   edits, the monotonically increasing controller generation for assignment fencing, and the
   renewable runtime lease token for one executing attempt. External effects retain the controller
   generation that authorized their intent and must still match it when completed.
5. Put external mutations behind a transactional saga/outbox: persist intent first, perform the
   idempotent external effect, then persist observed result. Never hold a database transaction open
   while calling Git, Codex, GitHub, or WCP.
6. Adapt tracker dispatch to create or recover a WorkSession before its first attempt. The tracker
   issue is origin data, not a required Attempt field. A null doctrine snapshot is a named
   compatibility state only until Phase 6b installs the accepted resolver; after that, every new
   session must pin a non-null portable doctrine reference before execution.
7. Treat fresh-attempt receipts and the workpad as compatibility projections. Startup reconciliation
   cross-checks Git/tracker/filesystem truth but never reconstructs missing authority silently.
8. Test migrations, corruption refusal, two-process compare-and-swap, stale fencing, crash after
   every state/effect boundary, backup/restore, and candidate-workspace independence.

**Exit:** all tracker attempts are children of one durable WorkSession; restart cannot double-run or
duplicate an outboxed tracker effect; the later manual controller needs no second store. Durable
managed-workspace and cleanup authority is the Phase 2 exit, not a Phase 1 claim.

### Phase 2: centralize repository lifecycle

**Repository:** Symphony.

1. Introduce the internal `RepositoryDriver` port.
2. Wrap current `directory` behavior and the legacy repository-hook behavior behind it without
   semantic change (`legacy-hook` mode in Seam D).
3. Implement the Symphony-owned Git worktree driver against temporary Git fixtures: resolve an
   allowed base ref from the trusted profile on the first managed allocation, pin its immutable SHA
   and repository/host identity for the complete WorkSession, verify the origin hostname derived
   from the tracker profile as well as owner/repository, generate a collision-safe branch in the
   allowed namespace, and store the `WorkspaceRecord` before the worktree is usable. Invoke exact
   operator-pinned Git with ambient Git authority scrubbed, hooks/fsmonitor and recursive
   submodules disabled, and executable clean/smudge/process filters refused before allocation, so
   worktree creation cannot execute product code. Later Attempts reuse the pinned SHA even if the
   mutable ref moves.
4. Implement idempotent create, inspect, reuse, fresh-attempt replacement, and guarded removal as
   fenced WorkSession saga steps. Reuse atomically supersedes the prior Attempt's lease while
   recording the new lease, so one physical path/branch never has two live cleanup owners. Removal
   requires a matching lease and controller generation, no active runtime lease, root-containment
   checks, and independent Git/filesystem verification; ambiguity retains the workspace with an
   actionable refusal.
5. Split configuration at its authority boundary. Load versioned product facts from the thin
   repository profile, but load the accepted profile reference, source checkout,
   state/workspace roots, branch namespace, tracker/credential binding, trusted runtime source,
   concurrency, and operational timeouts from a Symphony-owned deployment binding outside the
   product repository. The product must not select host paths or credentials; the operator binding
   must not rewrite profile bytes or redefine product proof meaning.
6. Resolve the profile and all authoritative authoring context from the binding's exact accepted
   product revision, never from the mutable candidate worktree. Validate and snapshot those inputs
   before dispatch. Bind tracker/repository identity, product profile/context revisions and digests,
   deployment-binding identity/digest, workspace provider/root, and source path to daemon host
   topology. Reject their live reload with a restart-required error so one open state store cannot
   begin governing a different repository or host binding.
   Binding v1's repeated tracker states and driver selectors remain a named compatibility snapshot;
   Phase 6b replaces them for new WorkSessions with the pinned `.github` tracker-policy contract.
7. Validate the managed source/origin/base and prospective workspace-root realpath before opening
   SQLite or creating `.symphony`; an overlapping root must fail without writing product source.
8. Own the managed agent launch boundary: product configuration may not replace `codex app-server`
   or weaken approval/sandbox policy; resolve the host executable outside source/workspace roots;
   launch it directly rather than through a login shell; deny command network, ambient temp roots,
   and inherited extra writable roots; and provide one Symphony-owned private temp root per runtime
   lease. Run the app server and its command descendants inside an attempt-owned process boundary;
   runtime completion must terminate and verify the absence of descendants before releasing the
   lease. Lease-clock expiry only nominates reconciliation; it cannot replace the Attempt until the
   same descendant proof succeeds. Sweep private runtime state after normal execution and guarded
   WorkSession cleanup.
9. Test interruption after every stateful transition, reject live topology rebinding, prove a
   moved base ref cannot change a later Attempt in the same WorkSession.
   Add an installed-app-server boundary probe showing worktree writes succeed while an attempted
   update to linked source Git metadata fails, including when the source sits below ordinary
   `/tmp`. Include a detached-child probe and require quiescence before the runtime lease closes.

**Exit:** a fixture product repository with no lifecycle hooks can be provisioned from an accepted
profile/context snapshot, edited by the managed agent, replaced, and cleaned up by the daemon while
that runtime cannot mutate trusted source Git, sibling roots, its own sandbox policy, or the
worktree after its lease ends.

### Phase 3: preparation driver

**Repository:** Symphony.

1. Implement the `pnpm` preparation driver the pilot needs only for a Symphony-managed worktree.
   Validate regular, non-symlink `package.json` and `pnpm-lock.yaml` files, record their digests and
   the exact frozen install and dependency-network policy intent before execution, and record the
   terminal preparation outcome (`succeeded | failed | setup_refused | interrupted`).
   A product selecting `preparationClass: none` carries no pnpm executable, sandbox, cache, or seed
   authority in its deployment binding. Refuse both missing pnpm authority for a `pnpm` profile and
   unused pnpm authority for a `none` profile.
2. Give each attempt a private cache outside the candidate worktree. Run pnpm in a fail-closed
   unprivileged filesystem/process sandbox that exposes only the managed worktree, that attempt's
   cache, the minimum runtime/toolchain roots, and required read-only system files. Supply a small
   environment allowlist rather than inherited credentials; do not mount home, sibling
   repositories, Symphony state, host-control sockets, or delivery/WCP credentials.
3. Replace shared host networking with an operator-owned dependency-egress policy. Validate every
   locked package source and integrity before execution; allow only approved HTTPS dependency
   registries/proxies needed by the pilot; deny loopback, host, private/link-local, metadata, custom
   Git/SSH, and arbitrary lockfile URLs. Record the network-policy identity/digest. If the restricted
   boundary cannot be constructed, or the complete store can instead be supplied offline, run
   offline or return `setup_refused`—never fall back to host networking.

   **Local v1 decision:** the candidate takes the fully offline branch of this requirement. The
   accepted binding records an approved HTTPS registry identity for lockfile provenance, but the
   preparation namespace has no network route. Symphony snapshots only pnpm's writable SQLite
   index into the Attempt-private cache and mounts the operator seed's content-addressed bytes
   read-only. An incomplete seed refuses/fails; no online retry path exists.

4. Always use a frozen lockfile and disable package-manager lifecycle scripts. The first driver has
   no opt-in escape hatch. A future script-capable preparation class requires a separate threat
   review and contract rather than a boolean that candidate configuration can flip.
5. Treat the complete managed worktree—not separately enumerated `node_modules` directories—as the
   workspace lease's cleanup unit. This central ownership makes the template's package-local
   install-artifact receipts unnecessary. Clean only the recorded attempt-cache subtree, refuse
   symlinks or containment ambiguity, and let the guarded RepositoryDriver retain or remove the
   worktree as one unit.
6. Keep manifests, lockfiles, and named product build entry points in the product repository. Do
   not add a second preparation driver until a second pilot needs one. This phase isolates the
   package-manager subprocess. It composes with Phase 2's separate managed-authoring sandbox and
   does not redefine the WCP protected-proof threat model.
7. Test interruption, timeout, detached-child termination, missing/linked inputs,
   lifecycle-script suppression, secret non-observation, sibling/state-path non-observation,
   localhost/private/metadata/custom-source refusal, dependency-policy drift, cache cleanup, and
   absence of an unsandboxed or shared-network fallback.

**Exit:** the fixture repository from Phase 2 runs an agent attempt with dependencies prepared and
torn down by Symphony alone, without exposing credentials, host files, or general host network.

### Phase 4: protected WCP proof v2 on the capacity-one canary

**Repository:** Workspace Control Plane; after its v2 contract is accepted, one separately accepted
thin Dyslexify GitHub caller/adapter change may exercise it. That product change contains no
worktree, preparation, retry, cleanup, or new product-proof implementation.

**Entry gate:** Symphony Phases 1–3 are accepted and merged; the narrow GH0
golden-principles/publication-owner change from Phase 0 is accepted and merged in `.github`; and
both checkouts are clean. This satisfies WCP's repository-local source/doctrine preconditions
without pulling the broader Phase 6a onboarding rewrite forward or treating green local candidates
as estate authority.

**Transport decision:** keep and harden the accepted GitHub/GARM path. The protected GitHub
event/caller supplies repository, base, and head identity; WCP validates enrollment and policy,
plans proof, allocates the existing max-one disposable runner, parses the protected result, and
publishes the required check. Symphony adds no proof transport. In Phase 5 it will only
materialize/push a head, open or recover its PR, and durably observe the WCP check bound to that
exact head.

The current WCP source/readiness evidence does not complete the connected lifecycle canary. Phase 4
must prove both that bounded live runner lifecycle and the different v2 claim that candidate code
and candidate workflow changes cannot select, reduce, forge, or publish the authoritative proof.
The canary uses an already-committed immutable Dyslexify head; it does not claim to turn authored
dirty bytes into a commit. That Symphony seam remains Phase 5.

The protected v2 plan minimally binds:

| Input       | Required identity                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Correlation | repository, event, PR, workflow run/job, and required-check IDs                                                                   |
| Source      | exact base/head commits and trees plus verified repository identity and ancestry                                                  |
| Authority   | GitHub App/enrollment, protected caller revision, control-plane commit, product-policy/adapter digests, planner/executor versions |
| Work        | mode, change classes, ordered required lanes, exact lane inputs, timeouts, and runner class                                       |
| Runtime     | image fingerprint, isolation profile, network policy, and attempt-owned resource prefix                                           |

Canonical JSON and its digest are protected artifacts. Candidate processes may read only the
bounded lane inputs needed for execution; they cannot write the plan, protected policy, result
channel, or caller-owned output path. The protected parser emits exactly one terminal product
outcome:

- `passed`: every admitted required lane completed and established its claim;
- `failed`: admitted proof completed and established a product failure;
- `setup_refused`: protected admission or preparation rejected the request before substantive
  proof could run; or
- `non_verdict`: cancellation, infrastructure failure, missing/duplicate/stale results, cleanup
  failure, or any other integrity failure prevents an authoritative product conclusion.

Cleanup status remains explicit evidence and can only preserve or weaken the outcome; it can never
turn another outcome into `passed`.

1. Add the now-accepted golden-principles route to WCP's owner-defined publication manifest and
   prove deterministic pointer/digest output. This is transport owned by WCP, not doctrine
   interpretation.
2. Define protected GitHub admission, repository identity, exact base/head binding, and base-owned
   change classification. Candidate edits to the caller, workflow, adapter, or labels cannot
   authorize or narrow their own required check.
3. Serialize one canonical affected-proof plan with a digest. Unknown or authority-changing diffs
   widen to full proof; candidate policy may add but never remove lanes.
4. Separate protected caller/admission, planner, executor, result parser, and final gate. Protect their
   entire transitive authority closure and pin external actions/workflows to full SHAs.
5. Execute candidate source under a distinct unprivileged VM identity with no writable access to
   plans, protected controls, credentials, GitHub output channels, or final result publication.
6. Preserve `passed | failed | setup_refused | non_verdict`, and bind lane results to source SHA,
   plan digest, adapter/policy digest, executor version, and runner/image identity.
7. Keep manual/nightly full regression independent of affected selection.
8. Add hostile tests that no-op the candidate wrapper, narrow configs, change/remove the candidate
   workflow, alter runner selection, escape output paths, mutate result channels, spoof stale or
   cross-repository events/results, and leave detached processes.
9. Render and review the exact v2 plan, then use the already-accepted max-one Dyslexify pool for one
   real protected canary plus cancellation/cleanup drill against an exact committed head. Verify the
   required check binds that head and no VM, runner registration, lock, network, result-channel, or
   temporary-source residue remains. Do not expand capacity as part of the canary.

**Exit:** a candidate-controlled no-op or workflow change cannot produce a green protected-final
check; four-way product semantics survive the GitHub/WCP boundary; and the v2 check contract is
proven on the existing max-one disposable-runner lifecycle. Making that stable check required for
Dyslexify merge is the product-owned Phase 8 decision.

### Phase 5: durable delivery correlation

**Repository:** Symphony.

1. Extend the accepted product-profile schema with the typed product-owner delivery grant and pin
   its governing `.github` policy reference on WorkSession creation. Define the delivery-provider
   port so credentials remain operator-owned and every operation receives the recorded grant,
   current tracker authority, immutable source identity, and fencing generation. Candidate source,
   agent output, and mere runtime possession cannot grant or widen delivery.
2. Pin an operator-owned proof transport authority on the WorkSession: one product-required check,
   exact `pull_request_target` caller path, and immutable WCP reusable-workflow repository/path/SHA.
   Admit artifacts only after GitHub's run metadata and the protected plan agree with that anchor;
   a same-named check or self-consistent candidate artifact pair is insufficient.
3. Stop authoring and release the runtime lease only after the attempt-owned app server and command
   descendants are absent. Acquire the exclusive materialization fence; verify the active managed
   workspace lease, pinned parent, branch namespace, runtime-temp cleanup, and independent
   Git/filesystem facts.
4. Add a trusted, restart-safe materialization saga that records intent and a bounded input
   manifest, applies the fixed source-inclusion policy through a Symphony-owned temporary index with
   no candidate hooks/filters/helpers, detects concurrent mutation, records tree and commit
   identity, and atomically advances only the recorded managed branch from its expected old SHA.
   Refuse ignored/runtime artifacts, oversized input, unsupported submodule/nested-repository/filter
   state, or any ambiguity rather than capturing them or falling back.
5. Add delivery state beneath WorkSession, binding the materialization record, branch, PR,
   immutable local/remote head SHA, WCP required-check/run/result identities, admitted proof
   plan/result, merge observation, cleanup, and release intent where authorized.
6. Put every remote mutation through the state-store saga/outbox with an idempotency key and
   fencing generation.
7. Push only the exact materialized head with an expected remote-ref state, then create or recover
   the PR against that immutable head. The protected GitHub/WCP path from Phase 4 supplies the
   required check; Symphony neither invokes a second proof transport nor accepts a check from a
   different SHA.
8. Add restart-safe WCP/CI waiting and outcome classification without sleeping agent turns.
9. Re-read Git hosting after any ambiguous command outcome before retrying; never infer success or
   failure from process exit alone.
10. Keep delivery credentials in a separate trusted provider process. Candidate preparation and
    agent execution never receive them.

**Exit:** edited worktree bytes become one recorded immutable commit without candidate Git-ref or
credential authority, and restart at any delivery boundary resumes against that exact PR head
without a duplicate mutation or unrelated green check.

### Phase 6a: align global doctrine

**Repository:** personal `.github`.

1. Add one compact execution-boundary map routing to Symphony and WCP contracts.
2. Preserve the Phase 0 golden-principles publication and governance index as the sole normative
   copy. Re-audit—without republishing—the stable `GP-01`–`GP-20` IDs, human exception authority,
   and amendment protocol against the now-delivered mechanisms.
3. Re-audit the enforcement map against the mechanisms actually delivered by the intervening phases;
   every row remains marked existing or planned and names its owning repository.
4. Publish the portable doctrine-reference contract consumed by Symphony: repository identity,
   canonical path, accepted revision, and content digest. Verify that it matches the route already
   transported by WCP's owner-defined deterministic bridge. The local `~/.github` path is a checkout
   location, not the durable identity.
5. Publish one portable machine-readable tracker-policy contract for the global lane, retry, and
   driver semantics. Make `.github`'s board creation/check tooling consume or verify the same value;
   do not create another hand-maintained copy merely for Symphony.
6. Define the `owner-gated` and `full-in-scope` delivery values precisely, including which
   materialize/push/PR/merge/release operations each permits and how current board state further
   constrains them.
7. Rewrite the doctrine/configuration/implementation split so product repositories retain product
   truth and thin adapters, not generic lifecycle machinery.
8. Rewrite onboarding around one repository profile and one proof adapter; replace "the five hooks"
   with the product `prove` entrypoint and a reference to Symphony's drivers.
9. Define `driver:direct` as "this board item is reserved for explicit human/direct work" and
   `driver:symphony` as "Symphony may run this board item when its status authorizes execution";
   this is what `agent-system/board-routing.md` already says and needs no semantic change here.
   Boardless interactive WorkSessions have no driver label and are not made equivalent to a direct
   board item.
10. Reduce worktree doctrine to global safety invariants and route implementation to Symphony.
11. Move Core-specific CI and delivery material back to Core.
12. Replace `scripts/linked-worktree-delivery.node-test.mjs` and any test that requires repository
    lifecycle hooks with owner-routing tests that reject copied machinery.
13. Add doctrine-boundary tests proving onboarding routes to one canonical file and does not copy its
    contents into generated or consuming repositories.
14. Define the tracker-origin exception-acceptance action and accepted human actor rule; an agent or
    automation-authored proposal is never acceptance.
15. Keep the existing rule that a driver change happens only in Backlog before a new attempt. A
    future controller handoff therefore ends the current Attempt, returns the issue to Backlog,
    changes the driver, then starts a new Attempt in the same WorkSession.

**Exit:** one accepted golden-principles file owns the global rules, one machine-readable tracker
policy owns the board/driver values consumed by Symphony, the enforcement map describes reality,
onboarding no longer instructs an agent to build Symphony features in a product repository, and the
hermetic `.github` tests enforce those boundaries.

### Phase 6b: pin accepted governance in WorkSessions

**Repository:** Symphony.

1. Implement a trusted governance resolver that consumes operator-approved repository identities,
   canonical paths, accepted revisions, and content digests for both golden principles and the
   tracker-policy value. Resolve them outside the candidate workspace; product code cannot select
   or rewrite its governing rules.
2. Refuse creation or execution of a new WorkSession when the accepted doctrine snapshot is null,
   malformed, or does not match the resolved bytes. A tracker-origin session additionally requires
   a valid tracker-policy snapshot. Historical transitional records with a null governance snapshot
   remain readable but cannot begin a new executable Attempt.
3. Expose the pinned reference and accepted context to prompt construction, status, and the workpad
   projection without copying the normative GP-01–GP-20 prose into Symphony or the product
   repository.
4. Implement the one tracker-origin structured acceptance route from Phase 6a. Verify the human
   actor's accepted repository authority, then append through the same revisioned WorkSession
   decision operation used later by interactive `steer`; never infer acceptance from proposal text
   alone.
5. Test that a running or recovered WorkSession retains its original revision and digest after the
   canonical doctrine is amended, while a newly created WorkSession receives the new accepted
   reference. Preserve explicit, cited human exceptions across restart.
6. For tracker-origin sessions, derive active/terminal/fresh-attempt behavior and driver selectors
   from the pinned tracker policy. Migrate deployment-binding v1 repetitions as compatibility input,
   reject disagreement, and do not accept them for new binding revisions after the migration gate.

**Exit:** every new executable WorkSession carries non-null, portable, immutable references to the
accepted doctrine that governs it and, for tracker origin, the exact `.github` tracker policy it
applies.

### Phase 7: rebuild the repository template

**Repository:** Workspace Repo Template.

1. Pin the accepted Symphony repository-profile schema and WCP proof-adapter schema.
2. Replace the four Symphony lifecycle hook scripts with a thin example product profile containing
   the repository-owned delivery-authority selection but no source/state/workspace path, runtime
   command, credential source, concurrency, timeout, or cleanup setting. Symphony deployment
   bindings are never generated into a product repository.
3. Add a thin WCP proof declaration and protected workflow example whose protected caller, actions,
   and reusable workflows use full immutable SHAs.
4. Add one thin route to the canonical `.github` golden principles. It may identify the source but
   must not copy the GP-01–GP-20 prose or make the product repository choose the governing revision.
5. Keep `prove.mjs` only as an intentionally product-shaped example, plus product tests,
   architecture, agent routing, and local decisions. Do not generate generic workflow,
   enforcement-register, profile, or adapter validators; their owners validate those contracts.
6. Delete `workspace.mjs`, `_receipt.mjs`, `install-artifacts.mjs`, `prepare-workspace.mjs`,
   `remove-workspace.mjs`, `tree-fingerprint.mjs`, `before-run.mjs`, `after-run.mjs`, and the tests
   that exist only for them.
7. Add negative template tests proving those responsibilities and copied principle text are absent.
8. Verify in template-owned generator fixtures that a generated repository contains no generic
   lifecycle/validator implementation or host binding and works when the test supplies a separate
   Symphony deployment binding plus the protected WCP proof path.

**Exit:** generating a repository no longer generates an orchestration implementation.

### Phase 8: migrate Dyslexify as the pilot consumer

**Repositories:** Symphony capability first; Dyslexify only in its separately authorized change.

1. Snapshot the existing Dyslexify profile, product proof entrypoint, required checks, and all live
   compatibility receipts/worktrees.
2. Configure Dyslexify's thin trusted product profile, preserving its already owner-accepted
   `full-in-scope` delivery grant as a typed value, and retain the exact v2 WCP adapter/caller proven
   in Phase 4; do not create a second proof declaration. Separately, install the operator-owned
   Symphony deployment binding outside Dyslexify; do not leave absolute workspace/state paths or
   runtime authority in the product checkout.
3. Through Dyslexify's own required-check authority, make the stable WCP v2 protected-final check a
   merge requirement for the managed path. This changes the enforcement route, not the product's
   canonical proof meaning or test suite; the candidate-controlled v1 wrapper is no longer an
   authoritative gate.
4. Use only the already-accepted max-one WCP/GARM Dyslexify boundary—do not add capacity—and run a
   board-backed Symphony journey through immutable push/PR, protected proof, Human Review, Merging,
   Done, and cleanup, including a daemon restart mid-attempt and mid-wait.
5. Confirm the attempt records the accepted golden-principles revision and digest, makes that
   context available to the agent, and preserves any cited exception across restart.
6. Only after central proof succeeds, remove Dyslexify's generic Symphony lifecycle code in a
   dedicated product-repository change.
7. Keep Dyslexify product tests and proof meaning unchanged. Any required-check change beyond the
   explicit v2 final-gate adoption is a separate product decision.
8. Close or reclassify the harness issues inventoried in Phase 0 as migrated external dependencies
   so they cannot silently restart local infrastructure development.

**Exit:** Dyslexify contains only product truth and thin adapters, with complete authoring, proof,
delivery, recovery, and cleanup evidence.

### Phase 9: manual MVP

**Repository:** Symphony. This phase is detailed by
[`interactive-control-plan.md`](interactive-control-plan.md).

1. Add `start`, `attach`, `plan`, `steer`, and `status` over the same `SymphonyStateStore` and
   WorkSession application service used by tracker origin.
2. Start only from an explicit absolute operator-binding file that passes the same resolver as the
   daemon; pin its internal ID and digest and bind the attached checkout to the same accepted
   repository/profile identity. Do not accept candidate workflow paths as authority and do not
   invent a binding registry merely for this command.
3. Record attached checkouts as session-level human-owned references, never Attempt workspace
   leases, and make them mechanically non-removable.
4. Keep attached dirty-tree proof local and advisory until work is committed or a future protected
   content-snapshot contract exists.
5. Do not add automatic agent execution/context injection, multi-repository coordination,
   controller handoff, board linking, pause/resume, prove/deliver commands, MCP, or an HTTP API to
   this MVP.

**Exit:** the user can drive the current conversational workflow with durable intent, plan,
steering history, and status while remaining the orchestrator.

### Follow-on migrations, not alignment blockers

After the Dyslexify pilot, migrate Storefronts and Project Tracker before removing the legacy-hook
compatibility driver. Each migration retains product proof and removes copied Symphony lifecycle.
Core, Market Intelligence, and Platform Infra onboarding each need their own product/authority
decision. A2A retirement needs a private archive, explicit deletion authority, re-verification of
untracked worktree contents, and its own runbook. None of these expands or blocks the five-repository
foundation plus Dyslexify/manual-MVP objective.

## Cross-repository change sequence

```text
F0  freeze copies + correct contracts
 │
 ├────────────▶ GH0 golden review + narrow publication change ──▶ clean .github checkout
 │
 └─▶ S1 WorkSession + SymphonyStateStore
       └─▶ S2 RepositoryDriver
             └─▶ S3 unprivileged preparation ─────┐
                                                  ├─▶ W1 protected proof v2
GH0 clean ─────────────────────────────────────────┘      │
                                                         └─▶ W2 v2 canary on existing max-one boundary
                                                               └─▶ S4 materialization + durable delivery

GH0 + S4 + W2 ──▶ GH1 doctrine rewrite ──▶ S5 doctrine resolver ──▶ T1 thin template
                                                                       └─▶ D1 Dyslexify pilot
                                                                              └─▶ I1 manual MVP

after D1: M1 Storefronts + Project Tracker ──▶ compatibility drain
separate: A2A retirement; Core/Market/Platform onboarding; controller handoff
```

Temporary documentation warnings may land early to stop new copies. Final adapter examples must
wait for the owning schemas so doctrine and templates do not guess their contracts.

## Verification strategy

### Repository-native gates

| Repository              | Ordinary source gate for relevant changes                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Symphony                | `pnpm check` and `pnpm build`                                                                                    |
| Personal `.github`      | `npm test`; run `node scripts/check-board.mjs` separately when live read authority and quota are available       |
| Workspace Repo Template | `pnpm typecheck`, `pnpm test`, and `pnpm boundaries`, plus generated-repository fixtures after lifecycle removal |
| Workspace Control Plane | `node scripts/harness/prove.mjs`; real isolation drills only for relevant host/image/security changes            |
| Harness Engineering     | Follow its prose/source/playbook verification instructions for the specific edited surface                       |
| Product pilot           | Product-native focused and full proof plus the protected WCP result                                              |

Live board writes, repository creation, remote pushes, PR mutations, runner activation, host apply,
and deletion of A2A or product worktrees are operational mutations. They are never implied by a
passing source gate and require the authority of the repository or system they affect.

### Cross-system acceptance journeys

1. **Tracker start and restart:** authorize an issue, create its WorkSession, provision through the
   driver, kill the daemon at each state/effect boundary, and recover without duplicate dispatch,
   duplicate external effects, or a second worktree.
2. **Profile, context, and host-binding tampering:** change candidate copies of the repository
   profile and authoring context and attempt to inject workspace roots/runtime settings. Prove the
   Attempt retains the accepted product/context snapshot plus operator deployment binding and that
   neither owner can silently redefine the other's facts or product proof.
3. **Provisioning interruption:** interrupt each managed-workspace transition and recover or refuse
   safely.
4. **Cleanup ambiguity:** alter path/Git metadata and prove Symphony retains the workspace with an
   actionable refusal.
5. **Authoring escape and materialization:** attempt to widen the Codex policy, replace the runtime,
   write linked Git metadata, use `/tmp`, leave a detached mutating child, and plant a
   hook/filter/nested repository, oversized file set, or concurrent writer before delivery. Prove
   authoring becomes quiescent and the trusted materializer either emits the exact recorded
   policy/manifest/tree/commit or refuses without moving the branch.
6. **Preparation egress:** point the lockfile at loopback, private/link-local/metadata addresses,
   custom Git/SSH, and an unapproved public host. Prove preparation either uses the recorded
   restricted dependency policy/offline store or refuses without host-network fallback or residue.
7. **Protected proof:** no-op the candidate wrapper, narrow candidate config, change/remove the
   candidate workflow, and spoof stale/cross-repository event or result data. Prove protected
   GitHub/WCP admission still selects and executes the base-owned floor for the immutable PR head,
   publishes the four-way required check through a protected parser, and leaves no runner/VM
   residue.
8. **Delivery restart:** restart Symphony while checks are pending and resume against the same PR
   head rather than an updated or unrelated run.
9. **Thin consumer:** onboard a fixture generated from the new template and confirm it contains no
   generic authoring lifecycle implementation.
10. **Doctrine pinning:** start a WorkSession under one accepted golden-principles revision, amend the
    canonical file, restart the daemon, and prove the session retains the original digest and
    human-accepted exceptions while a new session receives the amendment. Prove an agent-authored
    proposal cannot become an accepted tracker exception without the authorized human action.
11. **Manual continuity:** attach a dirty human checkout without creating an Attempt/runtime/workspace
    lease, record plan and steering, restart the CLI, and prove status survives while every
    Symphony cleanup path remains mechanically unavailable.

## Compatibility and rollback

- The legacy hook driver remains available while existing consumers and receipts exist. New
  consumers cannot select it.
- The SQLite schema migrates transactionally and preserves WorkSession generations. Compatibility
  receipts remain readable only while their live resources drain; they are never a second writer.
- Accepted doctrine revisions are immutable inputs to a WorkSession. A global amendment affects new
  WorkSessions; rollback never rewrites the doctrine or exception history of an existing session.
- No migration automatically removes an existing human checkout.
- A2A state is untouched by this plan; any later retirement has its own private archive and explicit
  deletion authority.
- WCP stays within the already-accepted max-one Dyslexify canary capacity. This plan neither expands
  it nor silently toggles its operational activation state.
- Template changes affect newly generated repositories. Existing repositories migrate through
  explicit changes; they are not silently rewritten from the template.
- Each repository change can roll back to its previous adapter while its durable records remain
  readable. A rollback that cannot read or safely retain existing resources is not acceptable.
- Remote and live control-plane changes are separated from source changes so a source rollback does
  not require guessing which external mutations already occurred.

## Decisions taken and implementation risks to prove

Taken on 2026-08-25 by the owner and whole-plan review:

1. Split interactive control into its own plan; this plan is driver-first.
2. Make WorkSession the aggregate root now, with tracker origin first and the manual surface later.
3. Use one transactional SQLite-backed `SymphonyStateStore`, not file records now and a second store
   for manual control later.
4. Order the work state/store → driver → unprivileged preparation → protected proof/canary →
   source materialization/delivery → doctrine rewrite → Symphony doctrine resolver → template →
   Dyslexify → manual MVP.
5. Treat A2A retirement and other-product onboarding as separate follow-on decisions.
6. Place accepted golden principles once in the personal `.github` governance repository; Harness
   Engineering informs them, Symphony pins and applies them, and templates/products only route to
   them.
7. Retain WCP's existing narrow doctrine-publication bridge; WCP transports deterministic pointers
   and digests but never authors or interprets doctrine.
8. Defer controller handoff. Manual MVP is only `start`, `attach`, `plan`, `steer`, and `status`.
9. Reuse WCP's accepted max-one GitHub/GARM Dyslexify transport. Do not add a second direct Symphony
   proof transport; Symphony correlates the protected required check to its exact delivered head.

The architecture is selected. These bounded risks must still be proven before their phase exits:

| Decision               | Recommended default                                                              | Must be proven before commitment                                               |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| SQLite durability      | Pinned `better-sqlite3`, WAL, transactional migrations and outbox                | Cross-process CAS, stale fencing, crash matrix, integrity, backup/restore      |
| Managed runtime        | Exact Codex sandbox plus an attempt-owned descendant-process boundary            | Escape probes, detached-child teardown, post-lease quiescence                  |
| Profile bootstrap      | Binding pins accepted profile revision; context resolves only from that revision | Dirty/candidate profile and context substitution tests                         |
| Preparation egress     | Fully offline namespace with an operator-pinned read-only pnpm seed              | Private/metadata/custom-source denial, seed integrity, and no network fallback |
| Source materialization | Trusted temporary index, no executable Git extensions, expected-old ref update   | Exact policy-selected tree, hostile attributes/config, crash/ref races         |
| WCP proof policy       | Protected GitHub caller/admission, affected floor, independent full regression   | No-op/workflow/event/output tests, source/head binding, admission, teardown    |
| Delivery authority     | Delivery gated by the recorded authority profile, never inferred from the runner | No push/merge/release without the profile permitting it                        |
| Workpad projection     | Symphony-owned attempt state with a revisioned human-readable comment            | Conflict handling when a human edits the issue comment                         |

## Definition of aligned

The estate is aligned only when all of the following are true:

1. The five infrastructure repositories publish compatible ownership statements with no shared
   capability claimed by two implementations.
2. Symphony's one WorkSession aggregate and state store own tracker and manual trajectories,
   attempts, leases, proof correlation, and delivery without duplicate state models.
3. Symphony creates, records, recovers, and removes managed Git worktrees without product lifecycle
   scripts; resolves accepted product context independently of the candidate; contains managed
   authoring to the worktree/private temp and process boundaries; prepares dependencies without
   general host-network authority; proves the runtime quiescent; and materializes the stopped
   working tree into an immutable commit without giving candidate code Git-ref authority or
   admitting runtime artifacts.
4. A `driver:symphony` item can be controlled by Symphony only in an authorized status; a
   `driver:direct` item is never claimed by it.
5. Workspace Control Plane alone plans, admits, constructs, parses, and gates protected proof; a
   candidate no-op cannot be authoritative.
6. The repository template contains thin product declarations and no host deployment binding,
   generic Symphony lifecycle, or shared validators.
7. Dyslexify completes the full autonomous, proof, delivery, restart, and cleanup pilot before its
   legacy lifecycle code is removed.
8. The manual MVP preserves the current human-orchestrated workflow through durable start, attach,
   plan, steer, and status operations without requiring a board or inventing an agent Attempt for a
   human-owned checkout.
9. `.github/agent-system/golden-principles.md` is the sole accepted global copy; every WorkSession
   pins its portable revision and digest, and no template or product repository contains copied
   GP-01–GP-20 prose.
10. WCP's deterministic doctrine bridge is explicit and interpretation-free.
11. Repository-native gates and the cross-system acceptance journeys pass with recorded evidence.

The concise boundary is:

> Harness Engineering supplies methods. `.github` supplies governance. The Template supplies a thin
> starting shape. Symphony supplies durable authoring and delivery mechanics. Workspace Control
> Plane supplies isolated proof. Product repositories supply product truth.

## Lifetime of this document

This plan is archived after Phase 9 and the separately tracked compatibility drain. Each section
then either dies with it or has already moved to
its owner:

| Section                                  | Destination when archived                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Header, checkpoint, one-sentence summary | Die with the plan; accepted revisions and evidence remain in each owner repository            |
| The estate in one picture                | `.github` execution-boundary map (Phase 6a.1)                                                 |
| Intended outcomes and non-goals          | Owner contracts below; migration-only wording dies with the plan                              |
| Shared vocabulary                        | `.github` boundary index; Symphony `SPEC.md` and WCP contracts for owner-specific terms       |
| Golden-principles ownership and protocol | `.github/agent-system/golden-principles.md`                                                   |
| Non-negotiable invariants 1–4, 11–17     | Symphony `SPEC.md`, operations, and `docs/repository-driver-boundary.md`                      |
| Non-negotiable invariants 5–6            | WCP GitHub proof contracts plus Symphony's required-check correlation contract                |
| Non-negotiable invariants 7–10           | `.github` execution-boundary/onboarding map; Symphony records doctrine/exceptions for 9–10    |
| Repository outcomes and ownership        | Each repository's own `AGENTS.md`/`ARCHITECTURE.md` ownership statement                       |
| A2A inventory                            | The Symphony issue that authorized retirement; then dies                                      |
| State and authority map                  | `.github` boundary index plus the owning Symphony, WCP, and product contracts                 |
| Seams C, D, E, G                         | Symphony `SPEC.md` extension sections and `docs/node-architecture.md`                         |
| Seam F                                   | WCP `docs/contracts/proof-adapter-v*.md`                                                      |
| Seam A                                   | Harness Engineering retrieval guidance                                                        |
| Seam B                                   | `.github` onboarding plus Symphony doctrine-resolution contract                               |
| Journeys, gap register, phases, sequence | Die with the plan                                                                             |
| Consumer estate and bill of change       | Dies with the plan; each repository's `AGENTS.md` and profile record its own state afterwards |
| Verification strategy                    | Each repository's own gate documentation; acceptance journeys become Symphony e2e tests       |
| Compatibility and rollback               | Symphony `docs/operations.md`                                                                 |
| Decisions                                | Symphony `docs/decisions/` if that directory exists by then; otherwise the merged PR record   |
| Definition of aligned                    | Final acceptance record; enduring conditions remain in the owner contracts above              |
