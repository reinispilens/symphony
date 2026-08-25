---
# COMPATIBILITY/MIGRATION REFERENCE ONLY.
# A daemon refuses this repository-owned git-worktree configuration. New managed deployments use
# examples/managed/repository-profile.json plus an operator-owned deployment binding.
tracker:
  kind: github-projects
  provider:
    owner: your-owner
    repo: your-repository
    project: 1
    hostname: github.com
    status_field: Status
    priority_field: Priority
    # Advertise the status tool only for transitions owned by the agent.
    agent_status_targets:
      - In Progress
      - Human Review
      - Done
  # Include selectors must all be present; exclude selectors must all be absent.
  required_labels: [driver:symphony]
  excluded_labels: [driver:direct]
  active_states:
    - Todo
    - In Progress
    - Merging
    - Rework
  # A state transition into Rework creates a new durable generation. Codex is
  # launched only after the repository reset and managed-workpad deletion pass.
  fresh_attempt_states:
    - Rework
  fresh_attempt_failure_state: Human Review
  # Successful normal polls reconcile newly terminal items even after an
  # inactive handoff released the worker claim. Startup repeats the full sweep.
  terminal_states:
    - Done
    - Cancelled
    - Duplicate

polling:
  interval_ms: 30000

workspace:
  # This documents the frozen pre-binding shape so existing consumers can be
  # diagnosed and migrated. It is not accepted as managed deployment authority.
  provider: git-worktree
  root: /absolute/path/to/repository-workspaces

repository:
  # Must match the configured tracker owner/repository and this workflow
  # checkout's independently observed Git origin.
  identity: your-owner/your-repository
  # A full trusted ref is resolved and pinned before the worktree effect.
  base_ref: refs/remotes/origin/main
  # Symphony adds collision-safe WorkSession and generation components.
  branch_prefix: symphony/

preparation:
  # Portable product class only. In managed mode the separate operator binding
  # pins the exact toolchain, offline seed/policy, and network-less sandbox.
  driver: pnpm
  frozen_lockfile: true
  lifecycle_scripts: false
  timeout_ms: 300000

agent:
  max_concurrent_agents: 1
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

You are implementing {{ issue.identifier }}: {{ issue.title }}.

Read the repository instructions and the complete issue before changing code. Keep the managed
GitHub issue workpad current with your plan, acceptance criteria, validation evidence, notes, and
open questions. Work only on this issue; file unrelated discoveries instead of expanding scope.

Issue description:

{{ issue.description | default: "No description was provided." }}

This is attempt {{ attempt | default: 0 }}. In ordinary states, inspect the existing managed
workspace before assuming this is a fresh run. In Rework, Symphony's RepositoryDriver has already
proven a fresh generation: read surviving reviewer comments with `github_issue_comments_list`, do
not recover rejected worktree state, and close any stale delivery named by the review before
replacing it. Finish the acceptance criteria, run the product repository's canonical proof path,
and move the card only through an agent-authorized status exposed by the available tools. Never
wait for interactive input.
