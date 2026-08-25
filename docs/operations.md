# Operating Symphony

> [!IMPORTANT]
> This runbook documents the managed-workspace implementation plus the existing
> hook-based compatibility route. New repositories use the Symphony-owned
> [`repository-driver boundary`](repository-driver-boundary.md); they do not implement Symphony
> lifecycle features locally. WCP protected proof, durable delivery, and the Dyslexify deployment
> pilot remain separate gates.

## Deployment map

```text
product A @ accepted Git SHA       operator-owned binding A
profile + prompt/context           tracker + roots + runtime
                └──────────┬──────────┘
                           ▼
                symphony@repository-a.service ──▶ Project A
                           │
                           ├── managed Git worktrees
                           ├── sandboxed preparation
                           └── systemd user scopes for agent descendants
                           ▼
                    state-root/state.sqlite
                 WorkSessions · leases · sagas · outbox

one service instance = one repository = one workspace root = one Project
```

Symphony is a daemon, not a command that should be launched once per issue. A supervisor keeps one
instance alive for each repository. For managed Git, an operator-owned binding is the deployment
contract. It pins one product profile/context revision and supplies the Project, host roots,
capacity, runtime, process-containment authority, and—when pnpm is selected—the exact preparation
toolchain plus offline dependency policy. Running several repositories in one Symphony process is
deliberately unsupported. Repository-owned `WORKFLOW.md` remains only for existing directory/harness
compatibility deployments.

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

Authenticate `gh` as the same operating-system user that will run the service. Use a protected
environment file readable only by root and the service identity when using token authentication. The credential needs read
access to the exact repository and Project plus write access only if provider-native workpad or
status tools are enabled.

Treat the workflow and every compatibility hook as privileged service code. Hooks intentionally run
on the parent side and inherit its environment; only the Codex child receives the scrubbed
tracker-secret environment.
A person who can change a deployed hook can therefore act with the daemon's filesystem and tracker
authority. Known tracker-secret values are redacted if `gh` or a hook echoes them into a captured
error, but that safeguard does not make untrusted hooks safe.

For a managed deployment, commit the thin product profile and prompt/context, then create the
separate binding from [`../examples/managed/deployment-binding.json`](../examples/managed/deployment-binding.json).
Replace its placeholder revision and digest with the exact accepted profile commit/blob digest.
Confirm that the source checkout's observed origin matches the tracker plus profile identity, the
profile's full base ref exists locally, and source/state/workspace roots are pairwise disjoint real
paths. The binding itself must be outside all three roots. For `preparationClass: none`, set the
binding's `preparation` value to `null`; an unused pnpm authority is refused. For
`preparationClass: pnpm`, point
`preparation.dependencyPolicy.seedStoreRoot` at the real parent of pnpm's versioned store directory:
if `pnpm store path` prints `/srv/pnpm/store/v11`, the configured root is `/srv/pnpm/store`. The seed
root must be disjoint from product, state, and workspace roots and must already contain
`v11/index.db` plus `v11/files` for every admitted dependency. Populate or refresh this trusted seed
as a separate operator action before starting Symphony; candidate preparation never fills it.

The binding always names exact regular paths for Git, Codex, `systemd-run`, and `systemctl`; a pnpm
binding additionally names preparation Node, the pnpm entry point, and Bubblewrap. Executable paths
cannot reside under product, state, or workspace roots, and preparation/seed paths may not use
symlink components. The service user must
have a working systemd user manager (`systemctl --user show --property=Version`) and unprivileged
Bubblewrap namespaces. Symphony verifies the pinned pnpm version during startup. Managed mode has
no unsandboxed or shared-network fallback. Each live authoring runtime receives one private temp
directory below `<stateRoot>/agent-runtime/` and one deterministic user scope. App-server exit does
not release authority: Symphony signals the complete cgroup, proves it empty, removes private
runtime state, and only then releases the lease.

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

Managed startup validates origin/base/root/executable facts before SQLite or workspace effects.
The binding, accepted profile/context, and host topology are pinned for the daemon lifetime; there
is no live reload. Stop cleanly, validate the new binding and state-root intent, then restart. Do
not work around a refusal by moving the database or editing candidate copies of the profile.

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
| `managed_workspace outcome=removed`                               | lease and independent Git checks authorized cleanup         |
| `workspace_cleanup outcome=completed` with `reason=poll_terminal` | normal poll reconciled a newly terminal released workspace  |
| `workspace_cleanup outcome=failed`                                | repository teardown needs operator attention                |
| `Harness-owned workspace was retained`                            | safety stop: the repository did not prove resource teardown |
| `worker action=cancel_requested` with a reason                    | reconciliation, stall detection, or shutdown stopped a run  |

There is no HTTP health endpoint or dashboard. The GitHub Project is the human control surface.
For embedded monitoring, `Orchestrator.snapshot()` exposes a synchronous view of running/retrying
rows, tokens, runtime, and rate limits without participating in scheduling decisions.

## Recovery playbook

On each successful normal poll, Symphony asks for active and terminal items in one state-list read.
It dispatches only active items and sends newly observed unclaimed terminal items through guarded
workspace cleanup. This includes a card that first moved to inactive Human Review, released its
worker claim, and only later became Done, Cancelled, or Duplicate. A daemon restart is not required
for that lifecycle.

On managed restart, Symphony resolves the exact binding/profile/context and opens
`<stateRoot>/state.sqlite`. An expired clock is only a reconciliation candidate: Symphony first
contacts the configured user manager, terminates the deterministic WorkSession/controller scope,
and proves its cgroup empty. Only then does the fenced transaction mark the old Attempt interrupted
and permit dispatch. If the user manager or observation fails, the lease stays active and no
replacement starts. Durable retry due times and pending effects remain discoverable; terminal items
are fetched before the first active poll. Managed worktrees are reused only when their durable lease
and independent Git/filesystem identity match; uncertainty is retained, never adopted or deleted.

If a card is stuck, first inspect its current Project status, WorkSession/Attempt IDs in the journal,
and the managed workspace's Git registration. Do not delete a workspace or branch by hand merely to
clear the symptom. A managed refusal means its state lease and observed Git/filesystem facts do not
agree; preserve both for diagnosis. On the compatibility path, the repository may still hold a
worktree record, database lane, port allocation, or receipt that only `before_remove` can release.
Repair the owning fact or compatibility teardown, then restart gracefully so the same guarded
driver re-evaluates it.

For a card in a configured fresh-attempt lane such as Rework, inspect
`fresh_attempt_handoff`, the WorkSession's managed lease phase, branch, and generation together.
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

The state, managed repository, and preparation foundations have deterministic local evidence, but
the first target is Dyslexify and remains blocked on four estate-level facts:

1. Workspace Control Plane protected proof v2 has passed its hostile tests and one capacity-one
   disposable-runner canary.
2. Symphony has durable delivery correlation for one immutable PR head and required proof result.
3. The accepted `.github` doctrine reference can be pinned into every new WorkSession.
4. Dyslexify supplies only its thin trusted profile and product-owned proof contract; its copied
   Symphony lifecycle is removed only after the complete replacement journey succeeds.

Do not compensate for these prerequisites with hidden paths, legacy config aliases, copied
repository harnesses, candidate-controlled proof, or unproven recursive deletion. Resolve product,
board, proof, and compute facts in their owning systems; keep authoring lifecycle in Symphony; and
record the real WorkSession, attempt, base/head SHAs, workspace lease, proof plan/result, PR, and
cleanup evidence in the deployment runbook.
