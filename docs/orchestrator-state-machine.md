# Orchestrator state machine

## The control loop in one picture

```text
                    tracker refresh
                          │
                          ▼
Unclaimed ──claim──▶ Running ──normal exit──▶ Retry queued (1 second)
    ▲                   │  │                         │
    │                   │  └──failure/stall─────────┤ exponential delay
    │                   │                            │
    │                   ├──terminal──▶ cleanup ──────┤
    │                   └──non-active/missing────────┤ no cleanup
    │                                                │
    └──────────────────── release ◀──── refresh ─────┘

Released + inactive ──later terminal poll──▶ guarded cleanup

All arrows that mutate claims, running entries, retries, or totals pass through one
serialized authority.
```

Fresh-attempt states add one guarded preflight before `Running`:

```text
state entry version ──▶ generation receipt ──▶ repository reset ──▶ workpad delete
                              │                                         │
                    matching ready: reuse                         success: Codex
                              │                                         │
                              └──── refusal: blocker + human handoff ◀──┘
```

The tracker state and the orchestration state answer different questions. A Project status such as
`Todo` or `Human Review` says whether humans authorize work. An orchestration state says whether
this process currently owns a claim, worker, or retry timer. Conflating the two would make a clean
Codex turn look like completed project work, even though the card may still be active.

The `Orchestrator` is the only mutable scheduling authority. Network reads and agent processes may
be concurrent, but every resulting state mutation is queued behind one promise chain. Claiming
happens synchronously before a worker promise is launched, so overlapping ticks, reload callbacks,
worker events, and retry timers cannot dispatch the same opaque issue ID twice.

## Tick order and eligibility

Every poll tick first reconciles existing workers, validates the workflow, then makes one state-list
read for the union of active and terminal states. Newly observed unclaimed terminal items go to
guarded cleanup even when workflow validation blocks new dispatch. Active candidates are sorted by
valid `P0..P3` priority, oldest creation time, and identifier. A card is dispatched only when all of
these independent gates agree:

| Gate                  | Owner                   | Meaning                                                     |
| --------------------- | ----------------------- | ----------------------------------------------------------- |
| Project scope/routing | tracker adapter         | exact repository, open issue, visible active Project status |
| state                 | workflow + orchestrator | active and not terminal                                     |
| labels                | workflow + orchestrator | every required and no excluded label matches                |
| ownership             | orchestrator            | neither running nor already claimed                         |
| capacity              | orchestrator            | global and normalized per-state slots are both available    |

The adapter's `dispatchable` flag is deliberately not a second scheduler. It records facts that
only that provider can know. Claims, include/exclude label selectors, and concurrency remain
generic, so adding a future adapter does not reproduce orchestration policy.

## Worker and continuation lifecycle

A worker receives an immutable workflow and tracker snapshot for the attempt. It creates or reuses
the workspace, runs `before_run`, renders the strict prompt, and starts one Codex app-server
process/thread. As long as ID refresh shows that the card is still active and routable, the runner
may send continuation guidance on the same thread up to `agent.max_turns`.

When that worker exits cleanly, the orchestrator schedules a fixed one-second continuation retry.
This is a deliberate state check, not a declaration that the issue is finished. An abnormal exit
starts at attempt 1 and uses:

```text
delay = min(10 seconds × 2^(attempt - 1), agent.max_retry_backoff_ms)
```

The retry entry retains the issue, attempt, due time, failure reason, retry kind, and the workflow
snapshot that owns its existing workspace. Fresh entries also retain their generation. When its timer fires, the issue is refreshed by opaque
ID. Terminal work is cleaned, missing or unroutable work is released, and eligible work is
redispatched if both capacity limits permit it. Slot exhaustion becomes an explicit retry reason
rather than dropping the claim.

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
For an unclaimed newly terminal item, it invokes the same workspace cleanup port used by startup
and active-run reconciliation. The workspace manager still delegates harness teardown to
`before_remove`; Symphony never substitutes generic deletion when that repository hook refuses.

Cancellation is cooperative at the runner boundary and forceful at the process boundary. The
runner closes the live app-server session and still executes `after_run`; the process transport
terminates its process group and escalates after a bounded grace period. A terminal transition then
invokes workspace cleanup. A non-active or invisible transition does not, because the repository
may need that durable workspace when a human sends the card back.

## Restart and observability

There is no required orchestration database. Normal polls derive newly terminal transitions from
the current and preceding successful terminal sets. At startup, every terminal tracker item is
swept through workspace cleanup, active items become ordinary candidates again, and
repository-owned receipts inside workspaces preserve external resource knowledge. Retry timers,
the preceding terminal set, and live session metadata are not persisted, so process restart
recovery remains tracker- and filesystem-derived.

The read-only snapshot is a view of this same state, never a second authority. It contains running
rows, retry rows, turn/session data, absolute-token aggregates, live plus ended runtime seconds,
and the most recent rate-limit payload. JSON logs carry stable action/outcome messages and the issue
and session context needed to correlate a transition.
