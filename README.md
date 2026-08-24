# Symphony

Symphony is a long-running service that turns authorized tracker work into isolated Codex runs. This
repository contains a strict TypeScript implementation of [`SPEC.md`](SPEC.md), built independently
from the bundled Elixir reference.

> [!WARNING]
> Symphony launches coding agents and repository-owned shell hooks. Run it only against trusted
> workflows and repositories.

## The system at a glance

```text
GitHub Project                 Symphony                         target repository
authorized issue ──poll──▶ claim + reconcile ──dispatch──▶ isolated workspace
       ▲                         │                                  │
       │                         └── Codex app-server ──────────────┤
       └──────────── status + durable workpad ◀─────────────────────┘

One daemon owns one WORKFLOW.md, one repository, and one Project.
```

Symphony owns coordination: polling, claims, concurrency, retries, cancellation, and aggregate
runtime state. The GitHub Projects adapter owns provider-specific scope and routing. The target
repository owns branch creation, dependency setup, proof, and teardown through lifecycle hooks.
Keeping those boundaries separate lets each repository enforce its own architecture without
teaching the scheduler about Git, package managers, databases, or CI.

## Requirements

- Node.js 22 or newer and pnpm 11.3
- Codex CLI compatible with the documented app-server contract; this build targets `0.147.0`
- GitHub CLI (`gh`) authenticated for the configured repository and Project
- A repository-owned `WORKFLOW.md` and, for harness-managed workspaces, implemented lifecycle
  scripts

Tracker credentials remain in the Symphony parent process. The Codex child environment is scrubbed
of the GitHub token aliases before launch, while provider-native tools execute host-side.

## Build and verify

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
node dist/cli.js --help
```

`pnpm check` runs formatting validation, strict type checking, and the deterministic test suite.
The isolated end-to-end test uses executable fake `gh` and Codex processes, so it exercises real
process, JSONL, hook, retry, and secret-boundary behavior without mutating GitHub.

## Configure one repository

Start from [`WORKFLOW.example.md`](WORKFLOW.example.md), place the finished file in the target
repository, and implement the hook entry points it names. The essential shape is:

```yaml
tracker:
  kind: github-projects
  provider:
    owner: your-owner
    repo: your-repository
    project: 1
  required_labels: [driver:symphony]
  excluded_labels: [driver:direct]
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Done, Cancelled, Duplicate]
  fresh_attempt_states: [Rework]
  fresh_attempt_failure_state: Human Review
workspace:
  provider: harness
  root: /absolute/path/to/workspaces
hooks:
  after_create: node "$SYMPHONY_WORKFLOW_DIR/scripts/harness/prepare-workspace.mjs"
  before_remove: node "$SYMPHONY_WORKFLOW_DIR/scripts/harness/remove-workspace.mjs"
agent:
  max_concurrent_agents: 1
```

Status remains the authorization gate. Required and excluded labels only select which executor may
claim an active item; changing either selector during a run causes Symphony to release that worker.

The first hook runs inside a newly created, empty workspace. That is why it addresses an explicit
script through `SYMPHONY_WORKFLOW_DIR`; a bare package-manager script cannot bootstrap an empty
directory. With `workspace.provider: harness`, the repository's `before_remove` hook owns deletion.
If teardown fails or leaves the path behind, Symphony retains it and logs the failure rather than
risk bypassing repository resource cleanup.

A configured fresh-attempt state is stricter than an ordinary active state. Each tracker state
entry produces a durable generation: Symphony requires the repository to remove the rejected
workspace/branch, provisions a new one, and deletes only the managed workpad before Codex starts.
Reviewer comments survive. If any proof fails, Symphony records the blocker and returns the card to
the configured human lane; a failed handoff retry never launches Codex.

Normal polls observe active and terminal states together. If a worker hands a card to inactive
Human Review and releases its claim, then an operator later moves the card to a terminal state, the
next successful poll invokes that same guarded `before_remove` hook. Startup still sweeps every
terminal item for restart recovery; restarting the daemon is not the normal cleanup trigger.

Run the daemon with an explicit workflow path:

```bash
node /path/to/symphony/dist/cli.js /path/to/repository/WORKFLOW.md
```

If the argument is omitted, Symphony uses `./WORKFLOW.md` from its current directory. It emits
JSON-lines logs to stderr, reloads valid workflow edits without restart, and keeps the last known
good configuration after an invalid edit. Invalid source pauses new dispatch while existing-worker
reconciliation continues. Stop it with `SIGINT` or `SIGTERM` for graceful worker cancellation.

## Documentation

- [`docs/node-architecture.md`](docs/node-architecture.md) explains component ownership and runtime
  flow.
- [`docs/orchestrator-state-machine.md`](docs/orchestrator-state-machine.md) explains claims,
  reconciliation, and retry transitions.
- [`docs/github-projects-adapter.md`](docs/github-projects-adapter.md) defines board scope,
  normalization, errors, and agent tools.
- [`docs/codex-app-server-protocol.md`](docs/codex-app-server-protocol.md) pins the tested Codex
  protocol boundary.
- [`docs/operations.md`](docs/operations.md) covers deployment, logs, recovery, and a systemd
  template.
- [`docs/conformance.md`](docs/conformance.md) maps the specification to deterministic evidence and
  records the remaining real-environment gate.

No HTTP server or dashboard is shipped. The Project is the human control surface; the daemon also
exposes an in-process, read-only runtime snapshot for adapters or future operator tooling.

## Current deployment boundary

The implementation and isolated integration profile are complete. A production run against the
`core` repository remains intentionally blocked until its worktree-root consolidation commit is on
`origin/main`, its workflow uses the explicit bootstrap hook, and a disposable Project item exists.
Those are target-repository and board prerequisites, not alternate behavior that belongs inside
Symphony.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
