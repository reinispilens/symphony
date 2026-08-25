# Rework fresh-attempt lifecycle plan

Status: implemented compatibility plan; repository-hook ownership superseded for new integrations
Owner: Symphony maintainers
Opened: 2026-08-24

> [!IMPORTANT]
> This document records the shipped hook-compatibility design and its historical rollout. Its
> conclusion that the target repository owns destructive reset is superseded. The accepted
> [`repository-driver boundary`](repository-driver-boundary.md) now has a managed
> implementation that moves reset, worktree ownership, leases, and recovery into Symphony while
> preserving the generation and human-handoff properties described here.

## Outcome

```text
human moves Human Review -> Rework
              |
              v
tracker state version -> durable fresh generation
              |
              v
guarded repository reset -> delete old Agent Workpad -> fresh branch/worktree
              |                                      |
              |                                      v
              +-- refusal -> blocker workpad -> Human Review
                                                     |
                                                     v
                                      Codex reads surviving review findings
```

A `Rework` card must never enter an old rejected workspace. Symphony either supplies a durable,
generation-matched fresh attempt or records the exact setup blocker and returns the card to the
configured inactive handoff state before Codex starts.

## Observed defect

The current workspace key is derived only from the issue identifier, so a Rework dispatch reuses
the rejected directory. Storefronts correctly refuses its dirty `before_run`, but that refusal is
treated as an ordinary worker failure. The result is an exponential retry loop which never reaches
Codex, never resets the workpad, and never returns the card to Human Review.

The rejected Storefronts #77 attempt demonstrated the complete failure chain on 2026-08-24.

## Architectural decisions

1. **Freshness is explicit workflow intent.** `tracker.fresh_attempt_states` names active states
   which require reset, and `tracker.fresh_attempt_failure_state` names the inactive driver-owned
   handoff state. The failure state must not be active or terminal.
2. **The tracker supplies a durable state version.** The GitHub adapter derives an opaque version
   from the Status field-value node and its update timestamp. Symphony hashes that version into a
   filesystem-safe generation. Missing version data is a reset refusal, not permission to reuse.
3. **Durable Symphony state makes restart behavior deterministic.** The compatibility driver uses a
   small receipt under the
   configured workspace root, outside the agent worktree. It records issue identity, workspace key,
   generation, and whether the workpad reset completed. A restart resumes the same ready generation
   and never deletes its new workpad again. The managed driver instead stores these facts beneath
   the WorkSession workspace lease and effect outbox in `state.sqlite`; no product receipt is its
   authority.
4. **The compatibility harness owns destructive reset.** For a new generation the implemented
   runtime invokes the existing `before_remove` hook with
   `SYMPHONY_RUN_STATUS=fresh_attempt_reset`. This was a safe transitional implementation, but new
   integrations must preserve the refusal invariant through a Symphony-owned repository driver
   rather than a copied target-repository hook.
5. **The old workpad is deleted, not rewritten.** After fresh workspace provisioning and before
   `before_run`, the tracker adapter deletes exactly one live `## Agent Workpad` comment. Other
   comments, especially the human review verdict, are untouched. The fresh agent creates its own
   workpad.
6. **Setup refusal belongs to the driver.** Workspace reset, branch creation, state-version, or
   workpad-reset failures produce a new blocker workpad and move the card to the configured inactive
   handoff state. A handoff mutation failure retries only the handoff; it never launches Codex in an
   unproven workspace.
7. **Reviewer evidence remains reachable.** The GitHub agent runtime exposes a bounded issue-comment
   reader which omits the managed workpad. During a fresh state it also exposes a repository-scoped
   PR-close operation, allowing the agent to close a stale delivery surface explicitly named by the
   review verdict.
8. **Internal retries are not new Rework generations.** Continuations and failure retries retain the
   generation selected at dispatch. A changed tracker version invalidates them and lets the next
   normal poll begin the newly authorized generation.

## State transitions

| Current fact                                | Driver action                 | Workspace action                                      | Board result                                |
| ------------------------------------------- | ----------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| ordinary active state                       | normal dispatch               | create or reuse deterministic workspace               | unchanged                                   |
| fresh state, no matching receipt            | begin fresh generation        | guarded reset, create branch/worktree, reset workpad  | run Codex                                   |
| fresh state, matching `provisioned` receipt | finish interrupted setup      | reset workpad once, mark ready                        | run Codex                                   |
| fresh state, matching `ready` receipt       | restart/internal retry        | reuse current fresh workspace and workpad             | run Codex                                   |
| fresh setup refused                         | no Codex process              | retain any resource the repository refused to release | blocker workpad, inactive handoff           |
| handoff mutation failed                     | retry handoff only            | no additional workspace mutation                      | remain claimed until resolved/state changes |
| fresh state version changed                 | cancel/release old generation | retain until new generation reset owns it             | next poll starts new generation             |

## Acceptance tests

- Configuration rejects a fresh state outside `active_states` and an active/terminal failure state.
- GitHub normalization returns a stable state version and refuses a fresh attempt when it is absent.
- A dirty rejected harness workspace is discarded only under `fresh_attempt_reset`; ordinary removal
  still refuses it.
- The repository receipt writes the new generation-aware schema and still reads the immediately
  preceding schema for safe teardown.
- A first fresh dispatch deletes one workpad, preserves ordinary comments, and creates a fresh
  branch from the approved base.
- Restart with a ready receipt reuses that generation without deleting its new workpad.
- Workspace or workpad reset failure starts no Codex process, records the blocker before status
  handoff, and does not enter the ordinary worker retry loop.
- A failed refusal handoff retries only the refusal operation.
- A later Rework status version supersedes an older queued retry.
- The agent can list surviving review comments, while PR close is available only during a configured
  fresh state and is restricted to the configured repository.
- Existing continuation, terminal-after-release, refusal-retention, secret-scrubbing, and workspace
  path-safety tests remain green.
- The managed successor additionally proves same-generation reuse, changed-generation replacement,
  crash recovery after Git creation without a second branch/worktree, and dirty/ambiguous cleanup
  retention against real temporary Git repositories.

## Live rollout for Storefronts #77

This section is a historical compatibility runbook, not the pilot sequence for the managed driver.

1. Keep #77 in Human Review and keep the old daemon stopped during implementation.
2. Close stale PR #76 under the already-authorized Rework decision.
3. Build the reviewed Symphony source and start one daemon with captured JSONL output.
4. Move #77 to Rework and observe the first successful poll.
5. Require evidence of a new status generation, deleted old workpad, preserved human review verdict,
   removed rejected worktree/branch, fresh replacement branch/worktree, and a Codex session started
   in that replacement.
6. If any condition fails, require the driver-created blocker and Human Review handoff; do not delete
   the workspace manually.
