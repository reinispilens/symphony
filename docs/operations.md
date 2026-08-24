# Operating Symphony

## Deployment map

```text
repository A ── WORKFLOW.md ──▶ symphony@repository-a.service ──▶ Project A
repository B ── WORKFLOW.md ──▶ symphony@repository-b.service ──▶ Project B
                                      │
                                      └── journal: JSON-lines logs

one service instance = one repository = one workspace root = one Project
```

Symphony is a daemon, not a command that should be launched once per issue. A supervisor keeps one
instance alive for each repository. The repository's workflow is the deployment contract: it names
the Project, active and terminal states, workspace root, hooks, capacity, and Codex command. Running
several repositories in one Symphony process is deliberately unsupported.

## Prepare a host

Install Node.js 22 or newer, pnpm 11.3, GitHub CLI, and the Codex CLI version recorded in
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

Treat the workflow and every referenced hook as privileged service code. Hooks intentionally run on
the parent side and inherit its environment; only the Codex child receives the scrubbed environment.
A person who can change a deployed hook can therefore act with the daemon's filesystem and tracker
authority. Known tracker-secret values are redacted if `gh` or a hook echoes them into a captured
error, but that safeguard does not make untrusted hooks safe.

Copy [`../WORKFLOW.example.md`](../WORKFLOW.example.md) into the target repository, replace every
placeholder, and implement every hook it enables. Validate the hook commands manually from an empty
disposable directory before starting a daemon. In particular, a harness `before_remove` hook must
remove the workspace itself; Symphony intentionally retains the path if repository teardown fails.

## Run directly

```bash
node /opt/symphony/dist/cli.js /srv/repositories/example/WORKFLOW.md
```

With no positional argument, the CLI resolves `WORKFLOW.md` from its current working directory.
`--help` and `--version` are the only flags. A configuration or startup failure exits nonzero;
`SIGINT` and `SIGTERM` cancel workers, close sessions, stop timers, and exit successfully after
shutdown finishes.

## systemd template

The following template assumes repository instance names are simple directory names beneath
`/srv/repositories`, workspace roots are configured outside the source checkout, and Symphony is
built at `/opt/symphony`.

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
WorkingDirectory=/srv/repositories/%i
EnvironmentFile=/etc/symphony/%i.env
ExecStart=/usr/bin/node /opt/symphony/dist/cli.js /srv/repositories/%i/WORKFLOW.md
Restart=on-failure
RestartSec=5s
TimeoutStopSec=90s
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
```

Create one credential file and instance per repository, then enable it:

```bash
sudo install -d -o root -g symphony -m 0750 /etc/symphony
sudo install -o root -g symphony -m 0640 /dev/null /etc/symphony/example.env
sudo systemctl daemon-reload
sudo systemctl enable --now symphony@example.service
sudo systemctl status symphony@example.service
```

Write environment assignments such as `GH_TOKEN=...` into the protected environment file without
shell `export` syntax. Adjust paths and the service account to the host, but keep each instance's
workflow and workspace root disjoint. `KillMode=control-group` is a final supervisor-level safety
net for hook and Codex descendants after Symphony's own graceful process-group shutdown.

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
SYMPHONY_WORKFLOW_PATH=/absolute/path/to/repository/WORKFLOW.md
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

The three configured paths are passed as separate arguments; no shell evaluates them. The required
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
| `Workflow reload rejected`                                        | reconciliation uses last good; new dispatch pauses          |
| `dispatch outcome=skipped reason=tracker_*`                       | no new work this tick; reconciliation remains available     |
| `retry outcome=scheduled`                                         | claim retained until refresh/retry decides its disposition  |
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

On restart, Symphony validates the current workflow, asks the tracker for every terminal item,
cleans their workspaces, and immediately polls active work. Running processes, the preceding
terminal-ID set, and retry timers are not restored; claims are rebuilt from the tracker, and
existing workspace directories are reused. This makes the tracker and repository receipts the
durable record while retaining a complete startup recovery sweep.

If a card is stuck, first inspect its current Project status and the daemon journal. Do not delete a
harness workspace by hand merely to clear the symptom: its repository may hold a worktree record,
database lane, port allocation, or receipt that only `before_remove` can release. A failing or
refusing hook leaves the path intact and the terminal ID is not hammered on every normal poll.
Repair the repository teardown command, then restart the daemon gracefully so the startup terminal
sweep invokes the same guarded hook again and confirms cleanup.

For a card in a configured fresh-attempt lane such as Rework, inspect
`fresh_attempt_handoff` and workspace-hook events together. Symphony stores its generation receipt
under `<workspace.root>/.symphony/fresh-attempts`, outside the agent worktree. `provisioned` means a
restart must still delete the old managed workpad; `ready` means the current generation may be
reused without deleting the new workpad. Never edit these receipts or delete the rejected worktree
by hand. Repair the repository hook or tracker authority, restart gracefully, and let the driver
either prove the reset or post the blocker and return the card to humans.

If a workflow reload is rejected, correct the file and save it again; no daemon restart is needed.
The last good snapshot remains available for existing-worker and terminal reconciliation, but no
new work is dispatched from stale intent. If GitHub is unavailable, workers whose state cannot be
refreshed keep running and reconciliation tries again on the next tick. Newly terminal cleanup and
new dispatch both remain paused for the failed state-list fetch. If Codex stalls, the configured
silence threshold cancels it and sends the issue through exponential retry.

## Production gate for the first target

The isolated daemon profile is green, but a real `core` deployment must wait for three external
facts:

1. Worktree-root consolidation commit `445025a4` must be present on `origin/main`; otherwise
   creation and teardown enforce different roots.
2. The target workflow must use the explicit `SYMPHONY_WORKFLOW_DIR` bootstrap entry point and the
   current config names.
3. A disposable Project item and a protected proof/merge path must exist for the real integration
   profile.

Do not compensate for these prerequisites with hidden paths, legacy config aliases, or generic
recursive deletion inside Symphony. Resolve them in the repositories and board that own the
contracts, then record the real item, workspace, PR, and cleanup evidence in the deployment runbook.
