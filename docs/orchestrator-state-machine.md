# Orchestrator state machine

> [!IMPORTANT]
> This document describes the durable-state implementation introduced with this change. The
> [`repository-driver boundary`](repository-driver-boundary.md) is implemented for managed Git
> worktrees; repository hooks and receipts below are compatibility behavior only.

## The control loop in one picture

```text
                       tracker refresh
                             │
                             ▼
Unclaimed ──transaction──▶ fenced Attempt ──normal exit──▶ durable Retry (1s)
    ▲                         │    │                              │
    │                         │    └──failure/stall──────────────┤ backoff
    │                         │                                   │
    │                         ├──terminal──▶ driver cleanup ──────┤
    │                         └──non-active/missing───────────────┤ retain
    │                                                             │
    └────────────────────── release ◀──────── refresh/timer ───────┘

Released + inactive ──later terminal poll──▶ guarded cleanup

The complete WorkSession aggregate + effect intents live in SQLite.
In-memory claims, workers, and timers are projections.
```

Fresh-attempt states add one guarded preflight before `Running`:

```text
state entry version ──▶ durable generation + managed lease ──▶ guarded replacement
                                 │                                  │
                       matching ready: reuse              workpad delete + Codex
                                 │                                  │
                                 └── refusal: outboxed blocker/handoff
```

The tracker state and the orchestration state answer different questions. A Project status such as
`Todo` or `Human Review` says whether humans authorize work. An orchestration state says whether the
WorkSession currently owns a runtime lease or retry intent. Conflating the two would make a clean
Codex turn look like completed project work, even though the card may still be active.

The `Orchestrator` is the only application component that requests scheduling transitions. Network
reads and agent processes may be concurrent, but durable mutations use immediate SQLite
transactions. Claiming creates or recovers the WorkSession and atomically acquires one runtime
lease before a worker promise is launched. The promise chain still serializes one process; the
database lease also rejects a second daemon process.

## Tick order and eligibility

Every poll tick first reconciles existing workers, then processes expired runtime-lease candidates.
For each candidate it must prove the matching descendant scope quiescent before committing the
fenced expiry; one unproven lease is retained and blocks new dispatch for that tick. The loop then
validates its pinned/compatibility source and makes one state-list read for the union of active and terminal states. Newly observed unclaimed terminal items go to
guarded cleanup even when workflow validation blocks new dispatch. Active candidates are sorted by
valid `P0..P3` priority, oldest creation time, and identifier. A card is dispatched only when all of
these independent gates agree:

| Gate                  | Owner                   | Meaning                                                     |
| --------------------- | ----------------------- | ----------------------------------------------------------- |
| Project scope/routing | tracker adapter         | exact repository, open issue, visible active Project status |
| state                 | workflow + orchestrator | active and not terminal                                     |
| labels                | workflow + orchestrator | every required and no excluded label matches                |
| ownership             | WorkSession store       | no active runtime lease or incompatible durable retry       |
| capacity              | orchestrator            | global and normalized per-state slots are both available    |

The adapter's `dispatchable` flag is deliberately not a second scheduler. It records facts that
only that provider can know. Claims, include/exclude label selectors, and concurrency remain
generic, so adding a future adapter does not reproduce orchestration policy.

## Worker and continuation lifecycle

A worker receives an immutable workflow/tracker snapshot plus fenced Attempt authority. The
RepositoryDriver creates or recovers its workspace; the PreparationDriver records and performs any
dependency setup; legacy `before_run` executes only on compatibility drivers. The runner then
renders the strict prompt and starts one Codex app-server process/thread. For a managed worktree it
uses exact operator-pinned Codex/systemd executables, creates one private state-root runtime temp,
launches the app server in a deterministic user scope, and supplies Symphony's exact no-network
per-turn write policy; repository configuration and user-wide writable roots cannot widen it. As long as ID refresh shows that the card is still active and routable, it
may send continuation guidance on the same thread up to `agent.max_turns`.

When that worker exits cleanly, the orchestrator schedules a fixed one-second continuation retry.
This is a deliberate state check, not a declaration that the issue is finished. An abnormal exit
starts at attempt 1 and uses:

```text
delay = min(10 seconds × 2^(attempt - 1), agent.max_retry_backoff_ms)
```

The durable retry entry retains the attempt counter, due/recorded times, failure reason, retry kind,
and fresh generation beneath the WorkSession. The in-memory timer and issue/workflow snapshot are
wake-up conveniences for retries scheduled by this process. After restart, ordinary polls read the
durable retry and cannot admit it before its recorded due time. When a timer or eligible poll fires,
the issue is refreshed by opaque ID. Terminal work is cleaned, missing or
unroutable work is released, and eligible work is redispatched if both capacity limits permit it.
Slot exhaustion becomes an explicit durable retry reason rather than dropping the claim.

A changed fresh-state generation invalidates the old worker or retry. A `fresh_handoff` retry is a
separate kind: it may repeat only the tracker blocker/status mutation and can never launch Codex.

Releasing an inactive continuation does not delete its workspace. The ordinary state-list poll
remembers the complete terminal-ID set from its preceding successful read. Human Review is absent
from that set; if the operator later moves the released card to Cancelled, Done, or Duplicate, the
next successful poll sees a new terminal ID and invokes cleanup. Restart is therefore recovery, not
the trigger required for this normal transition.

## Reconciliation and cancellation

Reconciliation precedes every dispatch cycle. Stall detection compares the current time with the
last Codex event, or the worker start time before the first event. A positive
`codex.stall_timeout_ms` cancels workers that have been silent too long; zero or a negative value
disables this check.

Running entries retain the adapter and workflow snapshot with which they started. That matters
after live reload: old workers refresh through their original adapter, while new dispatches use the
new one. Refreshes are grouped by adapter and may run concurrently, but their effects still occur
inside the serialized authority.

| Refreshed result                | Worker action | Workspace action | Claim outcome        |
| ------------------------------- | ------------- | ---------------- | -------------------- |
| terminal state                  | cancel        | clean            | release              |
| active and still routable       | continue      | retain           | keep                 |
| active but newly unroutable     | cancel        | retain           | release              |
| non-active state                | cancel        | retain           | release              |
| item missing from adapter scope | cancel        | retain           | release              |
| tracker refresh fails           | continue      | retain           | retry next poll tick |

Normal terminal reconciliation is deliberately separate from the running table. It skips any item
that is still claimed, because the worker/retry lifecycle must finish cancellation before cleanup.
For an unclaimed newly terminal item, it invokes the same repository-driver cleanup port used by
startup and active-run reconciliation. In the compatibility provider, that driver still delegates
harness teardown to `before_remove`; Symphony never substitutes generic deletion when that hook
refuses. New repository integrations use the managed Git-worktree driver, which requires its
durable lease, matching controller generation, no active runtime lease, and matching independent
Git/filesystem evidence.

Cancellation is cooperative at the runner boundary and forceful at the process boundary. The
runner closes the live app-server session; the process transport terminates its ordinary process
group, then the managed boundary signals and observes every process in the deterministic systemd
cgroup. It escalates TERM to KILL after a bounded grace period. Only a proven empty cgroup permits
private-runtime cleanup and terminal Attempt/lease release; otherwise the lease remains active for
reconciliation. Compatibility `after_run` still executes. A terminal transition then
invokes workspace cleanup. A non-active or invisible transition does not, because the repository
may need that durable workspace when a human sends the card back.

## Restart and observability

`<stateRoot>/state.sqlite` owns managed WorkSessions, accepted configuration/doctrine,
plans/decisions, session-level human attachments, attempts, runtime/workspace leases, preparation
outcomes, retries, materialization/proof/delivery state, and external-effect intents. Human
attachments are never Attempt workspace leases and are therefore outside every cleanup path. At
startup, versioned document migrations run transactionally. Expired timestamps nominate leases for
quiescence; they become interrupted only after the process boundary proves their descendant scope
empty. Durable retry due times remain authoritative to normal-poll admission, and pending effects remain
discoverable when their owning Git/tracker path is revisited. Every
terminal tracker item is swept through its selected cleanup driver. Git/filesystem/tracker facts are
still observed from their owners, but observation cannot manufacture missing Symphony cleanup
authority. Compatibility deployments retain the older workspace-root state location, and legacy
receipts remain readable only for compatibility resources.

The read-only snapshot is a projection of durable WorkSession facts plus live process telemetry,
never a second authority. It contains WorkSession/Attempt IDs, running rows, durable retry rows,
turn/runtime correlation, absolute-token aggregates, live plus ended runtime seconds, and the most
recent rate-limit payload. JSON logs carry stable action/outcome messages and the identities needed
to correlate a transition.
