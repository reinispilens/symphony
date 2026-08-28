# Specification conformance record

Status: managed governance, state, repository, preparation, orchestration, and ordinary-check
delivery are implemented and locally verified, 2026-08-28.

## What the local gate establishes

```text
accepted governance + product profile + operator binding
                         │
                         ▼
durable WorkSession → managed worktree → prepared Codex run
                         │
                         ▼
immutable commit → pull request → exact-head required checks → cleanup
```

`pnpm check` is the repository gate. It runs formatting validation, strict TypeScript checking, and
the deterministic Vitest suite. `pnpm build` separately proves the distributable TypeScript build.
The tests use temporary Git repositories and executable fake provider processes where process,
framing, environment, retry, or filesystem behavior matters. They do not claim a production GitHub
mutation occurred.

## Evidence map

| Area                       | Direct evidence                                                                                               | Status |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| Workflow and configuration | strict workflow, profile, binding, and path tests                                                             | pass   |
| Accepted governance        | exact manifest ancestry, Git blobs, digests, policy parsing, and drift fixtures                               | pass   |
| Durable state              | private SQLite state, migrations, revision/lease fences, effects, integrity, and backup                       | pass   |
| Repository lifecycle       | real temporary Git worktree allocation, recovery, fresh attempts, and guarded cleanup                         | pass   |
| Preparation                | offline pnpm/Bubblewrap admission, input integrity, environment isolation, and teardown                       | pass   |
| Tracker adapter            | GitHub Projects scope, pagination, normalization, mutations, and structured errors                            | pass   |
| Orchestration              | lane-aware authoring/delivery, retries, cancellation, restart, and cleanup                                    | pass   |
| Codex boundary             | app-server protocol, scrubbed environment, systemd-scope wrapper, and quiescence                              | pass   |
| Delivery                   | exact branch/head/PR checks, ordinary required-check observation, constrained merge, and restart-safe cleanup | pass   |
| CLI and service unit       | argument, version, composition, and systemd template tests                                                    | pass   |

The opt-in systemd integration test is skipped by the default suite because it requires a working
per-user systemd manager. Run it explicitly with:

```bash
SYMPHONY_SYSTEMD_INTEGRATION=1 pnpm exec vitest run \
  test/agent/systemd-user-scope.integration.test.ts
```

## Honest boundary

The repository proves the behavior Symphony owns. A real deployment must still supply and verify
its accepted governance publication, product profile, operator binding, GitHub credentials, Project,
and ordinary required checks. Production evidence should record the WorkSession and Attempt, exact
base/head commits, required-check results, pull request, and cleanup result.

No HTTP dashboard or manual WorkSession CLI is implemented. The Project remains the current human
control surface.
