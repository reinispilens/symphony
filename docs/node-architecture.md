# Node Symphony architecture

Status: implementation complete; real target deployment gated, 2026-08-24

## The system in one picture

```text
WORKFLOW.md
    │ config + prompt
    ▼
Workflow Store ──▶ Orchestrator ──▶ Workspace Manager ──▶ Codex app-server
                         │                  │
                         │                  └── repository-owned harness hooks
                         ▼
                 Tracker Adapter
                         │
                         └── GitHub Projects through `gh`

One process owns one workflow, one repository, and one board.
```

Symphony owns coordination: it observes authorized board work, claims one item, prepares its
isolated workspace, runs Codex, reconciles changes in tracker state, and retries safely. The target
repository owns how a workspace is populated, which resources it needs, and what constitutes proof.
The GitHub Projects adapter owns provider-specific facts such as board membership and
`dispatchable`; the generic orchestrator never inspects a GitHub payload.

The Elixir tree is a reference implementation only. The Node implementation is built from
`SPEC.md`; it does not import, wrap, or mechanically port Elixir modules.

## Architectural boundaries

| Boundary             | Owns                                                                                           | Must not own                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `workflow`           | file discovery, YAML parsing, typed defaults, strict prompt rendering, live reload             | tracker payloads, VCS behavior                 |
| `tracker`            | the two required reads, normalization, provider errors, provider-native agent tools            | scheduling, workspaces, generic retries        |
| `orchestrator`       | one serialized state authority, eligibility, claims, concurrency, reconciliation, retry timers | provider payload inspection, repository policy |
| `workspace`          | collision-resistant keys, root containment, lifecycle hooks, agent `cwd` invariant             | Git, package managers, database lanes          |
| `agent`              | Codex app-server framing, session/turn lifecycle, event mapping, secret-free child environment | tracker credentials, board policy              |
| `observability`      | structured operator-visible events and snapshots sourced from runtime state                    | a second source of orchestration truth         |
| CLI composition root | select one workflow, assemble one adapter and daemon, own process signals                      | multi-repository routing                       |

Dependencies point inward toward small contracts. The orchestrator receives a tracker port, an
agent-runner port, a workspace service, a clock/timer abstraction, and a logger. Provider and
process details stay at the edges, which makes the state machine deterministic to test.

## Runtime flows

### Startup

1. Resolve the explicit workflow path, or `<cwd>/WORKFLOW.md`.
2. Load and validate one last-known-good workflow snapshot.
3. Build the selected tracker adapter and validate its provider configuration.
4. Sweep workspaces for tracker items already in terminal states.
5. Start the workflow watcher, schedule an immediate tick, and register signal handlers.

Startup validation fails loudly. After startup, an invalid workflow edit is reported but does not
replace the last-known-good snapshot or stop reconciliation; it does pause new dispatches until a
valid source is observed.

### Poll tick

```text
reconcile running work
        ↓
re-read workflow preflight
        ↓ valid                         invalid ──▶ skip new dispatch
select the last-known-good workflow + adapter
        ↓
fetch active + terminal board items → normalize → remember terminal set
        ├── newly terminal + unclaimed ──▶ repository-owned guarded cleanup
        └── active + eligible ───────────▶ claim and dispatch while slots remain
```

Every mutation of `running`, `claimed`, retries, and token totals passes through the single
orchestrator authority. A tick never starts two workers for the same opaque issue ID.
The state-list read requests active and terminal states together. An in-memory set remembers the
terminal IDs from the preceding successful read, so a card that was released in inactive Human
Review and later becomes terminal is cleaned without either a second board scan or a daemon
restart. A terminal item that is still claimed is left to its worker or retry lifecycle so cleanup
cannot race agent shutdown.

### Worker attempt

1. For an ordinary active state, create or reuse `<workspace.root>/<workspace_key>`.
2. For a fresh-attempt state, derive a generation from the tracker state version. A new generation
   runs repository-owned guarded reset, provisions a new workspace, deletes only the managed
   workpad, and writes a durable `ready` receipt. A matching ready generation is reused.
3. Run repository hooks with the workspace as `cwd`.
4. Render the strict prompt from the workflow snapshot selected for this attempt.
5. Launch the Codex app-server with tracker credential variables removed.
6. Keep one process alive across continuation turns, up to `agent.max_turns`.
7. Always run `after_run`; report the result to the orchestrator for release or retry.

Codex never starts when fresh provisioning is unproven. The driver first records the exact blocker
in the managed workpad and then moves the card to the configured inactive human lane. If that
tracker mutation fails, the retry queue repeats only the handoff; it does not run workspace setup or
Codex again.

### Recovery

The spec deliberately has no required orchestrator database. Normal polls reconcile newly terminal
items, including items whose inactive handoff already released their claim. Process restart
recovery is still derived from the tracker and filesystem: every terminal item is swept, active
items become candidates again, and per-repository workspace receipts preserve repository-owned
allocations. A service session dying must not kill the detached daemon; daemon supervision is an
operational deployment layer, not multi-tenancy inside Symphony.

## Workspace bootstrap decision

`SPEC.md` creates an empty directory and then runs `after_create` with that directory as `cwd`.
Therefore `pnpm harness:prepare` cannot be the first command: the empty directory has no
`package.json`. The portable hook form is an explicit repository-owned entry point supplied through
the generic workflow-directory environment:

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
never silently falls back to generic deletion.

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
- A documented repository-owned workflow template and harness contract.
- System-level deployment guidance plus a checked per-user systemd unit for supervising one daemon
  per repository without tying its lifetime to a terminal or coding-agent session.
- An isolated daemon journey that releases an inactive Human Review claim, observes a later
  terminal transition on the normal poll cadence, and invokes the repository-owned teardown hook.

Gate: SPEC section 17.7 and an isolated end-to-end process fixture. The fixture composes real
workflow, adapter, workspace, Codex transport, runner, orchestration, continuation, and release
boundaries without external mutation.

### Phase 6 — real target operational proof: externally gated

- Run the real integration profile with a disposable board item and workspace.
- Prove terminal cleanup, cancellation, retry, restart recovery, token secrecy, and one complete
  `Todo → Human Review → Merging → Done` path.
- Record commands, artifact IDs, and cleanup evidence rather than relying on a green summary.

## External prerequisites and scope boundaries

These are required before the first `core` deployment, but they are not implementation work inside
this repository:

- `core` commit `445025a4` is still only on `chore/worktree-root-consolidation`; `origin/main` does
  not contain it. The target worktree root and teardown boundary therefore still disagree.
- The platform template workflow currently uses pre-spec aliases (`interval_seconds`,
  `max_concurrent`) and the non-bootstrapping `pnpm harness:prepare` form. It must be migrated rather
  than silently teaching Symphony a second schema.
- Required status check `ci-gate`, the `tasks.md` publisher, lane-vocabulary drift checks, and board
  creation live in their owning repositories. Symphony consumes their contracts; it does not absorb
  them.
- Concurrency remains one until target-repository capacity has been measured and reclaimed.

## Completion rule

The Node implementation is complete because every SPEC section 18.1 item and both shipped
extensions have deterministic evidence recorded in [`conformance.md`](conformance.md). Production
readiness for a particular repository is a second gate: its real smoke path must produce a proven
pull request and terminal cleanup without exposing tracker credentials to the Codex child. That
target-owned evidence is deliberately not inferred from the isolated profile.
