# GitHub Projects adapter profile

Supported `tracker.kind`: `github-projects`

## Scope and identity

One adapter instance reads one GitHub Project owned by the same user or organization as one target
repository. It resolves the owner through that repository, then selects the configured Project
number. This makes repository scope a provider-side fact rather than a title, label, or source-code
constant.

The opaque dispatch `Issue.id` is the `ProjectV2Item` node ID. The underlying GitHub Issue node ID,
owner, repository, issue number, and project-item ID are preserved as non-secret `native_ref` data.
The human identifier is `<repo>#<number>`, which is unique within the one-repository adapter scope.

Only GitHub Issue project items from the exact configured repository are schedulable. Draft issues,
pull requests, redacted content, cross-repository cards, archived cards, and cards without a Status
are not silently converted into work.

## Provider configuration

```yaml
tracker:
  kind: github-projects
  provider:
    owner: your-owner # required, non-empty
    repo: your-repository # required, non-empty
    project: 28 # required positive integer Project number
    hostname: github.com # optional
    status_field: Status # optional
    priority_field: Priority # optional
    agent_status_targets: [] # optional; exact statuses the agent may set
    timeout_ms: 30000 # optional positive integer
```

Unknown provider keys are preserved for forward compatibility. The adapter invokes
`gh api graphql --input -`; authentication therefore follows GitHub CLI host configuration. It
declares `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` as secret
environment names. The Codex child must receive none of them.

There is no token-valued provider key and therefore no provider-field `$VAR` substitution. `gh`
resolves its own stored host authentication or the four environment aliases above in the Symphony
parent. Path `$VAR` expansion remains available for `workspace.root`.

Validation errors use category `invalid_tracker_config` and name the invalid key. A project or
repository that cannot be resolved with the active credential is also surfaced as invalid/unusable
scope rather than falling back to another Project.

## Reads, pagination, and normalization

`fetch_issues_by_states` walks the configured Project in pages of 100 and filters requested Status
names case-insensitively. `fetch_issues_by_ids` uses `nodes(ids:)` in batches of 100 and verifies
that every returned item still belongs to the configured Project. Empty inputs make no provider
request. Page cursors must be non-empty and may never repeat.

Issue labels are fetched in pages of 100 when necessary, then trimmed, lowercased, de-duplicated,
and stripped of blanks. Other fields map as follows:

| Normalized field | GitHub source                                                                       |
| ---------------- | ----------------------------------------------------------------------------------- |
| `state`          | configured Project single-select Status spelling                                    |
| `state_version`  | SHA-256 of the Status value node ID and its `updatedAt`; unavailable data → `null`  |
| `priority`       | Priority `P0..P3` → `1..4`; anything else → `null`                                  |
| `description`    | Issue body or `null`                                                                |
| `assignee_id`    | first returned assignee node ID or `null`                                           |
| `branch_name`    | `null` (GitHub Issues do not supply branch metadata)                                |
| `blocked_by`     | `[]` until GitHub exposes a dependency relation this adapter can represent reliably |
| timestamps       | parsed Issue RFC 3339 timestamps, unusable values → `null`                          |

`dispatchable` is true only when all provider-owned eligibility checks pass: the card is a
non-archived GitHub Issue in the exact repository, the underlying issue is open, and its Status is
one of the workflow's active states. Required and excluded labels, claims, retries, and concurrency
remain generic scheduler checks.

A malformed state-list record is logged and omitted; the rest of a fully paged call may succeed. A
malformed requested ID aborts the complete ID-refresh call. A missing ID, an archived item, or an
item moved outside the configured Project/repository is an ordinary omission because it is no
longer visible in scope.

## Errors

Public failures are `TrackerError` instances with one stable category:

- `invalid_tracker_config`: invalid keys or invisible repository/Project scope
- `missing_tracker_secret`: GitHub CLI authentication failure
- `tracker_request`: CLI launch, transport, or timeout failure; retryable
- `tracker_status`: provider HTTP non-success reported by `gh`
- `tracker_response`: invalid JSON, GraphQL errors, or malformed required response data
- `tracker_pagination`: missing or repeated cursor
- `tracker_rate_limited`: rate-limit response; retryable

## Provider-native agent tools

The adapter binds these tools to the normalized issue and provider configuration captured for one
Codex session. Calls execute in the Symphony parent through the configured `gh` client; the Codex
child receives neither a token nor a credential argument.

`github_issue_workpad_upsert` is always advertised. Its input is `{ content: string }`. The adapter
constructs the managed `## Agent Workpad` heading, scans all issue-comment pages, creates the comment
when absent, or edits the one existing comment in place. Multiple workpads are an ambiguity error;
the adapter will not guess which history to overwrite.

`github_issue_comments_list` is always advertised. It accepts `{}` and returns at most 300 ordinary
issue comments while excluding the managed Agent Workpad. A fresh Rework agent uses it to recover
the reviewer verdict without recovering rejected execution state.

`github_pull_request_close` is advertised only when the bound issue snapshot is in a configured
fresh-attempt state. It accepts a positive repository-local PR number, scopes the read and mutation
to the configured owner/repository, and verifies the returned PR is closed. This lets a replacement
attempt retire the stale delivery named by a surviving review comment without exposing general
GitHub access.

`github_project_status_update` is advertised only when `agent_status_targets` is non-empty. Its
input schema contains those configured values as an enum. The adapter rejects every other target,
resolves the configured Status field and option IDs, performs `updateProjectV2ItemFieldValue`, and
verifies the returned item and Status. Thus lane names remain workflow data and an agent cannot use
the tool for a human-only transition unless the repository explicitly authorizes that target.

The adapter also provides driver-only fresh-attempt controls which are never advertised to Codex.
One deletes exactly the single managed workpad; the other upserts a provisioning-blocker workpad
and only then moves the Project item to the configured human failure lane. Review comments are not
deleted. A failed handoff is safe to retry because the blocker upsert and status assignment are
idempotent.

The mutation tools have no GitHub idempotency key: retrying a completed workpad
update is effectively idempotent because it edits the same comment, while a status update simply
sets the same field value again. Transport and rate-limit errors are returned as structured failures
with the tracker's retryability bit; malformed arguments and unauthorized statuses fail without a
provider request.
