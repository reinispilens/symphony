# Codex app-server protocol contract

Target captured: 2026-08-23

## The boundary in one picture

```text
Symphony parent (tracker credentials)
       │
       ├── host-side GitHub tools ──▶ GitHub through `gh`
       │
       └── scrubbed child environment
                    │
                    ▼
       compatibility                 managed deployment
 bash -lc <codex.command>      deterministic systemd user scope
                                      │ exact codex app-server
             └───────────────┬────────┘
                             │ stdio JSONL
                             ▼
 initialize → thread/start → turn/start → streamed events → turn/completed
                         same app server + thread for continuation turns
```

Symphony targets Codex CLI `0.147.0`. The experimental generated v2 schema has SHA-256
`ff10829cd75b67297019b39ab508ac699198574663579aa18336b7dc55ea178f`; the complete experimental
bundle has SHA-256 `babfd5c98cd978dd858b4762cdfbc9fba941e1a0e4053de0050e4082ae1f075a`. These values are also
recorded in `src/agent/protocol-contract.ts`.

Regenerate the exact artifacts after a Codex upgrade:

```bash
codex --version
codex app-server generate-ts --experimental --out <temporary-directory>
codex app-server generate-json-schema --experimental --out <temporary-directory>
```

Do not copy protocol shapes from `SPEC.md` or the Elixir reference. The generated artifacts and the
[official app-server protocol documentation](https://learn.chatgpt.com/docs/app-server) control
message names, framing, and payloads. The repository keeps the small subset it uses as explicit
runtime validators instead of committing hundreds of generated types that the implementation never
touches.

## Lifecycle and transport

The compatibility client launches `bash -lc <codex.command>`. Managed Git instead launches the
operator-pinned executable as `codex app-server` through `systemd-run --user --scope` with no login
shell and with systemd environment expansion disabled. Both use the issue workspace as `cwd`.
Stdout is the newline-delimited JSON protocol; stderr is diagnostic-only and is never parsed as
protocol. An input or output line is bounded to 10 MiB by default. A malformed or oversized stdout
line is a protocol failure, not a log message.

One connection sends `initialize`, then the parameterless `initialized` notification. It creates a
thread with `thread/start`, attaches the issue identity through `thread/name/set`, and starts each
turn with `turn/start`. Continuations reuse the live process and thread and receive a new turn ID.
Symphony exposes `session_id = <thread_id>-<turn_id>`.

`codex.read_timeout_ms` bounds synchronous request/response pairs. `codex.turn_timeout_ms` is a
silence timeout: every complete app-server output message rearms it. `turn/completed` maps
`completed` to success and maps `failed` or `interrupted` to typed run failures. Process exit,
malformed JSONL, and an unavailable command have separate error codes.

## Unattended policy

Compatibility workspace modes default to approval policy `never` and thread sandbox
`workspace-write`, while retaining protocol-native workflow overrides through
`codex.approval_policy`, `codex.thread_sandbox`, and `codex.turn_sandbox_policy`.

A Symphony-managed Git worktree is stricter. Its product profile cannot replace the Codex command
or weaken approvals, sandboxing, or process containment. The operator binding pins exact Codex,
`systemd-run`, and `systemctl` executables outside product/state/workspace roots. Symphony sends
`never` plus `workspace-write`. Every turn receives an explicit
`workspaceWrite` policy with network and ambient temp roots disabled. The only additional writable
root is a private temp directory under Symphony state for that runtime lease; Symphony supplies it
as `TMPDIR`/`TMP`/`TEMP` and removes it after the run or guarded WorkSession cleanup. A linked
worktree can therefore edit its files but cannot update the trusted source repository's shared Git
metadata merely because an operator has broad user-wide Codex writable roots. App-server exit is
not terminal proof: Symphony terminates and observes every process in the deterministic
WorkSession/controller cgroup before releasing the runtime lease. A failed observation retains the
lease and blocks replacement.

If Codex nevertheless sends a command or file approval request, Symphony responds
`acceptForSession` (`approved_for_session` for the legacy request variants) so the run cannot hang.

An `item/permissions/requestApproval` request is a different boundary: it asks Symphony to expand
the active filesystem or network permissions. Symphony grants an empty permission set for the
current turn, which deterministically declines that expansion while keeping the protocol moving.

Interactive user input is different: Symphony answers with an empty response to release the server
request, interrupts the active turn, and fails the attempt as `turn_input_required`. MCP elicitation
is declined. Any other unsupported server request receives JSON-RPC method-not-found. These choices
make every unattended path terminate deterministically.

## Provider-native tools and secrets

Dynamic tools require `initialize.capabilities.experimentalApi = true`. Symphony opts in only when
the selected adapter has tools, advertises that adapter's immutable tool snapshot on `thread/start`,
and services `item/tool/call` in the parent process. Unsupported tool names receive a structured
failure result and do not stall the turn.

Before spawning Codex, Symphony removes the adapter-declared secret names plus `GH_TOKEN`,
`GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN`, using a case-insensitive name
comparison. Tool execution retains the parent process's `gh` authentication and receives the
normalized issue snapshot internally; no credential is placed in tool arguments or results.
