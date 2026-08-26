# Operating Symphony

> [!IMPORTANT]
> This runbook documents the managed-workspace implementation plus the existing
> hook-based compatibility route. New repositories use the Symphony-owned
> [`repository-driver boundary`](repository-driver-boundary.md); they do not implement Symphony
> lifecycle features locally. Accepted-governance composition, lane-aware orchestration, WCP proof
> correlation, and durable delivery exist in Symphony. The final accepted-publication repin and the
> Dyslexify deployment journey remain separate estate gates.

## Deployment map

```text
personal .github @ publication SHA
accepted manifest ─▶ doctrine + tracker policy ─────┐
                                                     │
product A @ accepted Git SHA       operator binding v3 │
profile + prompt/context           tracker + roots + runtime + WCP trust anchor
                └───────────────┬───────────────┘
                                  ▼
                      accepted configuration
                                │
             ┌──────────────────┴──────────────────┐
             ▼                                     ▼
symphony@repository-a.service ──▶ Project A   local `symphony work`
             │                                     │
             ├── managed Git worktrees             └── human-owned checkout reference
             ├── sandboxed preparation                         │
             ├── systemd-scoped agents                         │
             └── durable PR/proof/delivery                      │
             └──────────────────┬───────────────────────────────┘
                                ▼
                         state-root/state.sqlite
                      WorkSessions · leases · sagas · outbox

one service instance = one repository = one workspace root = one Project
```

Tracker-origin Symphony is a daemon, not a command that should be launched once per issue. A
supervisor keeps one instance alive for each repository. Boardless manual commands are deliberately
short-lived and reopen that binding's same state store for one revision-fenced operation. For
managed Git, an operator-owned binding is the deployment contract. Version 3 pins one accepted
`.github` publication plus one product profile/context
revision and supplies the Project, host roots, capacity, runtime, delivery credentials,
process-containment authority, one exact WCP reusable-workflow trust anchor, and—when pnpm is
selected—the exact preparation toolchain plus offline dependency policy. Running several
repositories in one Symphony process is deliberately unsupported. Repository-owned `WORKFLOW.md`
remains only for existing directory/harness compatibility deployments.

## Prepare a host

Install Node.js 22 or newer, the exact pnpm 11.3.0 entry point used by the binding, Git, GitHub CLI,
Bubblewrap (`bwrap`), and the Codex CLI version recorded in
[`codex-app-server-protocol.md`](codex-app-server-protocol.md). Then build and verify the service:

```bash
cd /opt/symphony
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Authenticate `gh` as the same operating-system user that will run the service. For the built-in
GitHub delivery provider, place `GH_TOKEN` in a protected environment file readable only by the
service identity. The combined authority needs read access to the exact repository, Project,
workflow run, and artifact records; status/workpad, push, pull-request, or merge rights are needed
only for operations allowed by the pinned product grant and tracker lane.

Treat the workflow and every compatibility hook as privileged service code. Hooks intentionally run
on the parent side and inherit its environment; only the Codex child receives the scrubbed
tracker-secret environment.
A person who can change a deployed hook can therefore act with the daemon's filesystem and tracker
authority. Known tracker-secret values are redacted if `gh` or a hook echoes them into a captured
error, but that safeguard does not make untrusted hooks safe.

For a managed deployment, commit the thin product profile and prompt/context. Prepare a trusted
checkout of the personal/organization `.github` repository outside product, state, and workspace
roots; fetch both the manifest publication commit and the manifest's accepted artifact revision.
Create the separate version-3 binding from
[`../examples/managed/deployment-binding.json`](../examples/managed/deployment-binding.json). Replace
its placeholders with the exact profile and manifest revisions plus the SHA-256 digests of their Git
blob bytes. The product's delivery grant must name the accepted tracker-policy reference exactly;
the product cannot select a different policy or a mutable branch. Set
`deliveryProvider.proofAuthority.requiredCheck` to one check in that grant, then pin the exact
`pull_request_target` caller path and the Workspace Control Plane reusable workflow by repository,
path, and full commit. This is operator transport authority: do not copy WCP implementation into
the product repository.

Confirm that both checkouts' observed `origin` identities match their declarations, the product
profile's full base ref exists locally, and governance/source/state/workspace roots are pairwise
disjoint real paths. The binding itself must be outside all four roots. For
`preparationClass: none`, set the binding's `preparation` value to `null`; an unused pnpm authority
is refused. For `preparationClass: pnpm`, point
`preparation.dependencyPolicy.seedStoreRoot` at the real parent of pnpm's versioned store directory:
if `pnpm store path` prints `/srv/pnpm/store/v11`, the configured root is `/srv/pnpm/store`. The seed
root must be disjoint from governance, product, state, and workspace roots and must already contain
`v11/index.db` plus `v11/files` for every admitted dependency. Populate or refresh this trusted seed
as a separate operator action before starting Symphony; candidate preparation never fills it.

The binding always names exact regular paths for Git, Codex, the delivery provider, `systemd-run`,
and `systemctl`; a pnpm binding additionally names preparation Node, the pnpm entry point, and
Bubblewrap. Executable paths cannot reside under governance, product, state, or workspace roots,
and preparation/seed paths may not use symlink components. The service user must have a working
systemd user manager (`systemctl --user show --property=Version`) and unprivileged Bubblewrap
namespaces. Symphony verifies the pinned pnpm version during startup. Managed mode has no
unsandboxed or shared-network fallback. Each live authoring runtime receives one private temp
directory below `<stateRoot>/agent-runtime/` and one deterministic user scope. App-server exit does
not release authority: Symphony signals the complete cgroup, proves it empty, removes private
runtime state, and only then releases the lease.

## Operate a human-controlled WorkSession

Run manual commands as the same operating-system identity that can read the operator binding and
its private state root. This local filesystem authority is the MVP caller boundary; there is no
network listener or reusable controller token. The commands validate delivery-provider authority
but do not require or invoke its secret because they cannot prove or deliver work.

```bash
SYMPHONY=/absolute/path/to/symphony/dist/cli.js
BINDING=/absolute/operator/deployment-binding.json

node "$SYMPHONY" work start --binding "$BINDING" --intent "Describe the outcome"
```

Copy the returned session ID and revision into subsequent commands:

```bash
node "$SYMPHONY" work attach --binding "$BINDING" --session <id> --expected-revision 1 --path /absolute/product-checkout
node "$SYMPHONY" work plan --binding "$BINDING" --session <id> --expected-revision 2 --file /absolute/plan.md
node "$SYMPHONY" work steer --binding "$BINDING" --session <id> --expected-revision 3 --message "A correction"
node "$SYMPHONY" work status --binding "$BINDING" --session <id>
node "$SYMPHONY" work status --binding "$BINDING" --session <id> --json
```

Use the revision printed by the immediately preceding successful mutation; a stale value is an
intentional concurrency refusal. The plan file has this minimal form:

```markdown
## Plan

Explain the intended steps and boundary.

## Acceptance criteria

- Name one observable completion condition.
- Name another completion condition.
```

`attach` does not switch branches, install dependencies, start a coding agent, or change repository
bytes. A nested path is recorded as its canonical Git root. Symlinks, wrong origins, control-root
overlap, and paths already claimed by an active WorkSession are refused. There is no detach command
in this MVP because the attachment is durable evidence and never Symphony cleanup authority.

`status --json` is designed for local tools but is not the raw aggregate: lease tokens, effect
payloads, provider errors, prompts, environment values, and transcripts are omitted. Back up and
restore the manual session through the same `<stateRoot>/state.sqlite` procedure below. Do not copy
the database while a daemon or manual writer can still mutate it; use the store's online backup
port from embedding code or stop the daemon before the documented offline copy.

Managed Git commands do not inherit `GIT_DIR`, `GIT_WORK_TREE`, configuration injection, replacement
objects, global/system config, hooks, fsmonitor, or recursive submodule behavior. Before allocation,
Symphony also refuses effective repository clean/smudge/process filter commands. Treat that refusal
as an unsupported repository feature requiring an explicit central design; never enable the filter
merely to make checkout proceed.

During preparation, Symphony copies the trusted seed's SQLite index into the Attempt-private cache
and mounts its content-addressed bytes read-only. It then validates all workspace manifests,
lockfile sources and SHA-512 integrity records, bounded `pnpm-workspace.yaml`/`.npmrc` inputs, and
the exact `packageManager` version. Git/SSH/URL/local sources, pnpm hooks, lifecycle scripts,
runtime downloads, loopback/private/metadata access, and input drift are refusals. A missing package
is therefore `setup_refused` or `failed` evidence that the operator seed is incomplete; it is never
permission to retry with host networking.

Managed startup validates governance ancestry/blobs, product origin/base, roots, and executables
before SQLite or workspace effects. The binding, resolved publication, accepted profile/context,
and host topology are pinned for the daemon lifetime; there is no live reload. A repin affects new
WorkSessions only: existing sessions retain the complete policy value stored at creation. Stop
cleanly, validate the new binding and state-root intent, then restart. Do not work around a refusal
by moving the database or editing candidate copies of the profile or governance files.

Version-3 delivery can use the checked-in
`bin/symphony-github-delivery.mjs` wrapper installed with Symphony. Keep it outside governance,
product, state, and workspace roots and preserve its executable bit. Name only the credential
environment variables it needs in the binding; Symphony refuses missing names, scrubs them from
candidate execution, and sends the provider a credential-free JSON request on stdin. The provider
returns one bounded protocol-v1 observation on stdout. It admits protected proof only from the WCP
plan/result artifacts for the exact repository, run, attempt, immutable head, plan digest, and check
run. It first proves from GitHub's own run metadata that GitHub Actions executed the configured
`pull_request_target` caller and exact pinned WCP reusable workflow revision. A same-named green
check, self-consistent fake artifacts, or a run through another reusable workflow is not delivery
evidence.
Treat a timeout, non-zero exit, truncated response, or invalid JSON as an ambiguous remote mutation:
inspect exact provider truth before retrying. Never give the coding agent the provider credential as
a workaround.

Version-1 and version-2 bindings remain readable for migration and historical inspection, but they
have no accepted-governance snapshot. Symphony therefore refuses to start a new managed Attempt
from them; upgrade the external binding rather than copying policy into the product repository.

Materialization and delivery are resumable WorkSession operations, not repository hooks. Do not
run `git add`, `git commit`, push, PR, merge, or branch cleanup from a product-owned lifecycle script
for a managed deployment. If Symphony refuses unsupported repository state (filters, submodules,
nested repositories, active `info/exclude`, oversized input, or concurrent mutation), retain the
workspace and repair or explicitly redesign that boundary; do not broaden the inclusion policy.

The accepted tracker policy separates lane activity from authoring. `Todo`/`In Progress` may launch
Codex when the issue has exactly the Symphony driver; `Human Review` may materialize, push, open a
PR, and observe proof without an agent slot; `Merging` may additionally merge only for a
`full-in-scope` product grant. `owner-gated` never causes Symphony to merge. Moving a session to
`Rework` first closes its exact unmerged PR, releases its exact remote branch, and performs guarded
local cleanup before a fresh Attempt is admitted. A completed delivery moves to `Done` only through
the typed tracker transition after remote release and local cleanup are recorded.

For an existing hook-based compatibility deployment, validate every configured hook manually from
an empty disposable directory before starting a daemon. In particular, a harness `before_remove`
hook must remove the workspace itself; Symphony intentionally retains the path if repository
teardown fails. Do not create a new repository harness.
[`../WORKFLOW.example.md`](../WORKFLOW.example.md) is only a parseable migration reference; a
positional workflow that selects `git-worktree` is refused.

## Run directly

```bash
node /opt/symphony/dist/cli.js --binding /etc/symphony/example.binding.json
```

Positional paths and the no-argument `./WORKFLOW.md` fallback are compatibility-only. A managed
configuration or startup failure exits nonzero. `SIGINT` and `SIGTERM` cancel workers, quiesce
their descendant scopes, stop timers, and exit successfully only after shutdown finishes.

## System-level systemd compatibility template

The following outer service is suitable for compatibility workflows. A managed binding additionally
requires a functioning per-user systemd manager and bus for the service identity; the checked
per-user template in the next section is therefore the preferred managed deployment.

```ini
# /etc/systemd/system/symphony@.service
[Unit]
Description=Symphony daemon for %i
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=symphony
Group=symphony
WorkingDirectory=/opt/symphony
EnvironmentFile=/etc/symphony/%i.env
ExecStart=/usr/bin/node /opt/symphony/dist/cli.js --binding /etc/symphony/%i.binding.json
Restart=on-failure
RestartSec=5s
TimeoutStopSec=90s
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
```

Create one protected credential file and binding per repository, verify that the service identity's
user manager is available, then enable it:

```bash
sudo install -d -o root -g symphony -m 0750 /etc/symphony
sudo install -o root -g symphony -m 0640 /dev/null /etc/symphony/example.env
sudo systemctl daemon-reload
sudo systemctl enable --now symphony@example.service
sudo systemctl status symphony@example.service
```

Write environment assignments such as `GH_TOKEN=...` into the protected environment file without
shell `export` syntax. Adjust paths and the service account to the host. `KillMode=control-group` is
an outer daemon safety net; it does not replace the distinct attempt-owned user scope that Symphony
must prove empty before releasing a runtime lease.

## Per-user systemd service

For a single-user development workstation, use the checked-in user-service template instead of
starting Symphony from a terminal or coding-agent session. The service is owned by the user's
systemd manager, so closing the launching shell cannot terminate the daemon.

Install the template and create one required environment file per repository instance:

```bash
install -Dm0644 deploy/systemd/user/symphony@.service \
  "$HOME/.config/systemd/user/symphony@.service"
install -Dm0600 /dev/null "$HOME/.config/symphony/storefronts.env"
```

Populate `~/.config/symphony/storefronts.env` with absolute, stable paths. This file uses systemd
environment-file syntax, not shell `export` syntax:

```text
SYMPHONY_NODE_PATH=/absolute/path/to/node
SYMPHONY_CLI_PATH=/absolute/path/to/symphony/dist/cli.js
SYMPHONY_BINDING_PATH=/absolute/path/to/operator/deployment-binding.json
PATH=/absolute/tool/bin:/usr/local/bin:/usr/bin:/bin
```

Build Symphony before starting or restarting the unit, then let the user manager own its lifecycle:

```bash
pnpm check
pnpm build
systemctl --user daemon-reload
systemctl --user enable --now symphony@storefronts.service
systemctl --user status symphony@storefronts.service
journalctl --user -u symphony@storefronts.service -f -o cat
```

The three configured paths and literal `--binding` flag are passed as separate arguments; no shell evaluates them. The required
environment file makes a missing deployment configuration fail visibly instead of falling back to
the caller's current directory. Do not put tracker credentials in the unit file. Prefer the user's
existing `gh` authentication; if token authentication is necessary, keep it only in the mode-0600
instance environment.

A user manager normally survives terminal closure but may stop after the user's final login session.
If this workstation must dispatch while that user is logged out, an administrator must explicitly
enable lingering with `loginctl enable-linger <user>`. That host-level persistence decision is not
performed by Symphony or implied by enabling the unit.

## Logs and health

The default sink is stderr, which systemd captures in the journal. Each line is one JSON object with
`timestamp`, `level`, `message`, and operation-specific fields. Follow one instance with:

```bash
journalctl -u symphony@example.service -f -o cat
```

For the per-user service, add `--user` to `journalctl` as shown above.

Healthy operation is visible as `service outcome=started`, periodic dispatch activity, and explicit
worker/retry/cleanup outcomes. Investigate these signals first:

| Signal                                                            | Meaning                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `service outcome=failed`                                          | startup or host lifecycle failed; systemd will restart      |
| `Workflow reload rejected`                                        | compatibility source invalid; new dispatch pauses           |
| `dispatch outcome=skipped reason=tracker_*`                       | no new work this tick; reconciliation remains available     |
| `retry outcome=scheduled`                                         | claim retained until refresh/retry decides its disposition  |
| `runtime_lease outcome=lost`                                      | this process is fenced; inspect competing/restarted daemon  |
| `runtime_lease outcome=retained reason=quiescence_unproven`       | descendant scope could not be proven empty; dispatch stops  |
| `attempt outcome=retained reason=quiescence_unproven`             | worker ended but its lease remains authoritative            |
| `preparation outcome=succeeded`                                   | frozen sandboxed dependency preparation completed           |
| `delivery outcome=awaiting_checks`                                | exact PR exists; protected artifact verdict is not ready    |
| `delivery outcome=awaiting_owner`                                 | owner-gated PR is ready; Symphony will observe, not merge   |
| `delivery outcome=completed`                                      | merge/release/guarded cleanup and Done effect were recorded |
| `managed_workspace outcome=removed`                               | lease and independent Git checks authorized cleanup         |
| `workspace_cleanup outcome=completed` with `reason=poll_terminal` | normal poll reconciled a newly terminal released workspace  |
| `workspace_cleanup outcome=failed`                                | repository teardown needs operator attention                |
| `Harness-owned workspace was retained`                            | safety stop: the repository did not prove resource teardown |
| `worker action=cancel_requested` with a reason                    | reconciliation, stall detection, or shutdown stopped a run  |

There is no HTTP health endpoint or dashboard. The GitHub Project is the human control surface.
For embedded monitoring, `Orchestrator.snapshot()` exposes a synchronous view of running/retrying
rows, tokens, runtime, and rate limits without participating in scheduling decisions.

## Recovery playbook

On each successful normal poll, Symphony asks for every lane that the pinned policy may reconcile.
It dispatches only authoring lanes, resumes delivery-only lanes without an agent slot, and sends
newly observed unclaimed terminal items through guarded workspace cleanup. This includes a card
that moved to inactive Human Review, released its worker claim, and later received an external
merge or became Done, Cancelled, or Duplicate. A daemon restart is not required for that lifecycle.

On managed restart, Symphony resolves the exact binding/governance/profile/context and opens
`<stateRoot>/state.sqlite`. Each existing WorkSession continues with its stored tracker-policy
snapshot even if the restarted daemon points at a newer accepted publication. An expired clock is
only a reconciliation candidate: Symphony first
contacts the configured user manager, terminates the deterministic WorkSession/controller scope,
and proves its cgroup empty. Only then does the fenced transaction mark the old Attempt interrupted
and permit dispatch. If the user manager or observation fails, the lease stays active and no
replacement starts. Durable retry due times, pending delivery sagas, and pending effects remain
discoverable; tracker truth is refreshed before the first mutation. Managed worktrees are reused
only when their durable lease and independent Git/filesystem identity match; uncertainty is
retained, never adopted or deleted.

If a card is stuck, first inspect its current Project status, WorkSession/Attempt IDs in the journal,
and the managed workspace's Git registration. Do not delete a workspace or branch by hand merely to
clear the symptom. A managed refusal means its state lease and observed Git/filesystem facts do not
agree; preserve both for diagnosis. On the compatibility path, the repository may still hold a
worktree record, database lane, port allocation, or receipt that only `before_remove` can release.
Repair the owning fact or compatibility teardown, then restart gracefully so the same guarded
driver re-evaluates it.

For a card in the pinned fresh-attempt lane such as Rework, first inspect the delivery phase and its
close/release/cleanup effects, then inspect `fresh_attempt_handoff`, the WorkSession's managed lease
phase, branch, and generation together. A fresh workspace is not legal until prior delivery
abandonment is complete.
`allocating`/`provisioned` means restart reconciliation must finish or refuse the recorded effect;
`ready` means the same generation may be reused without deleting its workpad again; `superseded`
means ownership was atomically transferred to a later Attempt and is not another cleanup target.
Never edit the database, compatibility receipt, or rejected worktree by hand. Repair Git/tracker
authority, restart gracefully, and let the driver either prove the transition or post the blocker
and return the card to humans.

If a compatibility workflow reload is rejected, correct the file and save it again; no daemon
restart is needed. Managed bindings never reload: a changed binding or accepted profile requires a
clean restart. If GitHub is unavailable, workers whose state cannot be
refreshed keep running and reconciliation tries again on the next tick. Newly terminal cleanup and
new dispatch both remain paused for the failed state-list fetch. If Codex stalls, the configured
silence threshold cancels it and sends the issue through exponential retry.

## State backup and restore

The store exposes an online SQLite backup operation to embedding code. Until an operator CLI is
added, use this conservative offline procedure for a deployment backup:

1. Stop the one daemon for this binding gracefully, confirm the daemon exited, and confirm no
   `symphony-agent-*.scope` for its WorkSessions remains active. This closes the database and
   checkpoints its WAL; do not copy a live database file while ignoring its `-wal` file. Symphony
   creates the main database, `-wal`, and `-shm` files with private mode `0600` inside the mode-`0700`
   state directory.
2. Resolve the exact binding state root, then copy only `<stateRoot>/state.sqlite` to a new
   non-existing private path. Never overwrite an older backup. Compatibility deployments retain
   their older `<workspace.root>/.symphony/state.sqlite` location.
3. From the built Symphony checkout, open the copy read-only with the same pinned SQLite binding and
   require `PRAGMA quick_check` to return `ok`:

   ```bash
   node --input-type=module -e '
   import Database from "better-sqlite3";
   const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
   const result = db.pragma("quick_check", { simple: true });
   db.close();
   if (result !== "ok") throw new Error(`quick_check: ${String(result)}`);
   ' /private/backups/symphony-state-YYYYMMDD.sqlite
   ```

4. Restart the daemon and confirm `service outcome=started`.

To restore, stop the daemon, preserve the current database under a different private name, install
the verified backup as mode `0600` at the exact state path, and start Symphony. Startup migrations,
aggregate validation, and integrity checking must all pass before dispatch. If they fail, stop and
restore the preserved current file; never "repair" authority by deleting rows or rebuilding leases
from worktree directories.

## Production gate for the first target

The governance, state, managed repository, preparation, and delivery implementation now has
deterministic local evidence. WCP proof v2 and its capacity-one execution boundary exist externally.
The first target is Dyslexify and remains gated by two integration facts:

1. Spec 001 lands the final golden-principles/tracker-policy wording and republishes one accepted
   manifest whose exact references can be pinned by the deployment binding.
2. A disposable Dyslexify item proves the composed journey using only its thin product profile and
   product-owned proof contract. Its existing harness is not modified during this pilot; legacy
   lifecycle retirement occurs only after replacement evidence is complete.

Do not compensate for these prerequisites with hidden paths, legacy config aliases, copied
repository harnesses, candidate-controlled proof, or unproven recursive deletion. Resolve product,
board, proof, and compute facts in their owning systems; keep authoring lifecycle in Symphony; and
record the real WorkSession, attempt, base/head SHAs, workspace lease, proof plan/result, PR, and
cleanup evidence in the deployment runbook.
