# Symphony

Symphony is a long-running service that turns authorized tracker work into isolated Codex runs. This
repository contains a strict TypeScript implementation of [`SPEC.md`](SPEC.md), built independently
from the bundled Elixir reference.

> [!WARNING]
> Symphony launches coding agents and, on the legacy compatibility path, repository-owned shell
> hooks. Run it only against authorized workflows and repositories. A managed deployment fixes the
> Codex and process-containment policy centrally; compatibility workflows remain privileged input.

## The system at a glance

```text
product repository                 Symphony operator
profile + prompt @ Git SHA         deployment binding outside product
             └──────────────┬──────────────┘
                            ▼
GitHub Project ──poll──▶ durable WorkSession + fenced Attempt
                            │
                            ├── RepositoryDriver ─────▶ managed Git worktree
                            ├── sandboxed preparation ▶ frozen dependencies
                            └── systemd scope ────────▶ Codex app-server + descendants

SQLite under the operator-selected state root records the complete WorkSession aggregate and
effects. One daemon owns one accepted binding, one repository, and one Project.
```

Symphony owns coordination and generic authoring mechanics: polling, claims, concurrency, durable
retries, fenced attempts, managed Git worktrees, preparation, cancellation, and restart recovery.
The GitHub Projects adapter owns provider-specific scope and routing. The product repository owns
its code, tests, proof meaning, and a thin trusted profile; it does not implement Symphony's
worktree lifecycle.

`workspace.provider: harness` remains available only to drain existing consumers. New integrations
use the implemented [`repository-driver boundary`](docs/repository-driver-boundary.md) and must not
copy lifecycle machinery into target repositories. Protected WCP proof, durable delivery, doctrine
pinning, the Dyslexify pilot, and manual WorkSession commands are the next estate phases and are not
claimed here as complete.

## Requirements

- Node.js 22 or newer and pnpm 11.3
- Git CLI for `workspace.provider: git-worktree`
- Bubblewrap (`bwrap`) for `preparation.driver: pnpm`; preparation fails closed when it is absent
- Codex CLI compatible with the documented app-server contract; this build targets `0.147.0`
- GitHub CLI (`gh`) authenticated for the configured repository and Project
- A functioning per-user systemd manager for managed app-server descendant containment
- An operator-owned deployment binding for managed workspaces; legacy directory/harness consumers
  retain their repository-owned `WORKFLOW.md` temporarily

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

## Managed repository configuration

> [!IMPORTANT]
> New integrations have two independently owned inputs. The product declares portable product
> facts; the Symphony operator declares host authority. A product file cannot choose host paths,
> credentials, concurrency, or the runtime executable.

The product repository commits a thin `.symphony/repository-profile.json` and its prompt/context:

```json
{
  "schemaVersion": 2,
  "repositoryIdentity": "your-owner/your-repository",
  "baseRef": "refs/remotes/origin/main",
  "authoringContext": {
    "promptPath": ".symphony/prompt.md",
    "paths": ["AGENTS.md"]
  },
  "preparationClass": "pnpm",
  "deliveryGrant": {
    "authority": "owner-gated",
    "governingPolicy": {
      "repositoryIdentity": "your-owner/.github",
      "path": "agent-system/tracker-policy.json",
      "revision": "0000000000000000000000000000000000000000",
      "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "requiredChecks": ["proof / Protected final"]
  }
}
```

Outside the product repository, the operator creates a deployment binding. It pins the profile by
repository, path, exact commit, and digest, then supplies the tracker, source checkout, disjoint
state/workspace roots, branch namespace, capacity, timeouts, exact Codex executable, and exact
Git/`systemd-run`/`systemctl` executables. For pnpm products it also pins exact Node, pnpm, and
Bubblewrap paths plus one versioned offline dependency policy and a read-only seed-store root. See
[`examples/managed/deployment-binding.json`](examples/managed/deployment-binding.json) and
[`examples/managed/repository-profile.json`](examples/managed/repository-profile.json).
When the accepted profile selects `preparationClass: "none"`, the binding sets `preparation` to
`null`; Symphony neither requires nor validates an unused pnpm toolchain or seed. A missing or
extra pnpm authority is a profile/binding mismatch and is refused.

A version-2 binding also names one operator-owned delivery-provider executable and only the secret
environment-variable names it receives. The provider performs credentialed hosting operations from
typed, credential-free requests; candidate execution never receives those credentials. Symphony
materializes edited source through its own bounded manifest and temporary index, then correlates
push, PR, exact-head protected checks, grant-constrained merge, and cleanup durably across restart.

Run only the binding for a managed repository:

```bash
node /path/to/symphony/dist/cli.js --binding /etc/symphony/your-repository.json
```

Status remains the authorization gate. Required and excluded labels only select which executor may
claim an active item; changing either selector during a run causes Symphony to release that worker.

The managed driver verifies that the accepted source checkout's `origin` host and owner/repository
match the tracker-resolved hostname plus the product profile identity, resolves the configured full
base ref once for the WorkSession's first managed allocation, and
durably pins that immutable SHA for every later Attempt even if the mutable ref advances. It then
allocates a collision-safe branch and records ownership before running the Git effect. It reuses
only an exactly matching recorded worktree. Cleanup independently checks the state lease,
configured root, Git common directory, registered worktree path, branch, and cleanliness. Any
ambiguity retains the checkout with an actionable refusal.

Every managed lifecycle operation launches the binding's exact Git executable with ambient Git
target/config variables removed, global/system configuration disabled, hooks and fsmonitor off,
and recursive submodules off. Repositories with configured executable clean/smudge/process filters
are refused before workspace allocation; a checkout cannot turn provisioning into product-code
execution.

Managed authoring also has a Symphony-owned runtime boundary. Product files cannot replace the
Codex command or weaken approval, sandbox, or process-containment policy. Symphony validates the
operator's exact executables outside product/state/workspace roots, launches `codex app-server`
without a login shell, denies ambient network and temporary-directory writes, and grants only the
managed worktree plus one private Attempt temp directory under the state root. The app server runs
in a deterministic systemd user scope with environment expansion disabled. Symphony terminates and
proves that complete cgroup empty before it releases the runtime lease; clock expiry alone never
authorizes a replacement Attempt.

The pnpm preparation driver admits the complete package-manager input set: regular non-symlink
manifests, lockfile, bounded workspace configuration, and a small safe `.npmrc` profile. It rejects
pnpm hooks, local/Git/SSH/URL dependencies, arbitrary tarballs, missing SHA-512 integrity, and input
drift. Bubblewrap gives the exact pnpm process only the managed worktree, a private attempt cache,
minimum read-only toolchain roots, and a read-only operator seed. It creates a new network
namespace, runs `--offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile`, and has neither a
shared-network nor unsandboxed fallback. Each attempt gets a private writable copy of the seed's
small package index while content-addressed package bytes remain shared read-only. The complete
managed worktree is the cleanup unit, so product repositories need no package-install ownership
receipts.

A configured fresh-attempt state is stricter than an ordinary active state. Each tracker state
entry produces a durable generation: Symphony's driver replaces only the previously recorded
managed worktree, provisions a new branch/worktree, and deletes only the managed workpad before
Codex starts. Reviewer comments survive. If provisioning is refused, Symphony records the blocker
and returns the card to the configured human lane; a failed handoff retry never launches Codex.

Normal polls observe active and terminal states together. If a worker hands a card to inactive
Human Review and releases its claim, then an operator later moves the card to a terminal state, the
next successful poll invokes guarded driver cleanup. Startup also reconciles expired runtime leases,
durable retries, and terminal workspaces from `<stateRoot>/state.sqlite`; restarting the daemon is
not the normal cleanup trigger.

### Legacy hook compatibility

Existing repositories may temporarily retain `workspace.provider: directory|harness` and their
existing hook behavior. [`WORKFLOW.example.md`](WORKFLOW.example.md) is now only a parseable
migration reference for the frozen repository-owned format. Positional workflow startup is
compatibility-only and refuses `git-worktree`. Existing harness consumers may retain `after_create`
and `before_remove` hooks. In that mode the repository still owns deletion, and Symphony never
falls back to generic removal after a failed teardown. Do not use that profile for a new consumer;
its only purpose is a safe compatibility drain.

Run a compatibility daemon with an explicit workflow path:

```bash
node /path/to/symphony/dist/cli.js /path/to/repository/WORKFLOW.md
```

If the argument is omitted, Symphony uses `./WORKFLOW.md` from its current directory. That live
reload behavior applies only to compatibility deployments. A managed binding and its exact accepted
product revision are pinned for the daemon lifetime; changing either requires a clean restart. The
daemon emits JSON-lines logs to stderr and stops on `SIGINT` or `SIGTERM` after cancellation and
runtime-quiescence checks complete.

## Documentation

- [`docs/node-architecture.md`](docs/node-architecture.md) explains component ownership and runtime
  flow.
- [`docs/orchestrator-state-machine.md`](docs/orchestrator-state-machine.md) explains claims,
  reconciliation, and retry transitions.
- [`docs/github-projects-adapter.md`](docs/github-projects-adapter.md) defines board scope,
  normalization, errors, and agent tools.
- [`docs/codex-app-server-protocol.md`](docs/codex-app-server-protocol.md) pins the tested Codex
  protocol boundary.
- [`docs/operations.md`](docs/operations.md) covers deployment, logs, recovery, and both system and
  checked per-user systemd templates.
- [`docs/conformance.md`](docs/conformance.md) maps the specification to deterministic evidence and
  records the remaining real-environment gate.
- [`docs/repository-driver-boundary.md`](docs/repository-driver-boundary.md) records the implemented
  Symphony-owned repository lifecycle and thin-adapter contract.
- [`docs/dyslexify-orchestration-handoff.md`](docs/dyslexify-orchestration-handoff.md) records the
  corrected ownership and planning lessons from the Dyslexify pilot.

No HTTP server, dashboard, or manual WorkSession CLI is shipped yet. The Project is the current
human control surface; the daemon also exposes an in-process, read-only runtime snapshot whose
attempt and retry facts are projected from durable WorkSession state.

## Current deployment boundary

The durable WorkSession store now uses its version-2 aggregate contract: accepted
product/context/binding inputs, plans and decisions, human attachments outside Attempt leases,
materialization/proof/delivery records, and the existing fenced attempts/retries/outbox all share
one transactional root. The managed Git-worktree driver, accepted profile/operator-binding split,
separate state root, exact Codex sandbox/systemd scope, quiescence-before-lease-release, and
offline-only pnpm preparation path are implemented and covered by deterministic and
real-Git/process fixtures. Production pilot readiness still requires WCP protected proof v2 and its
capacity-one canary, durable delivery
correlation, accepted doctrine publication, and a recorded Dyslexify end-to-end journey. No
product repository should fill those gaps with another local harness.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
