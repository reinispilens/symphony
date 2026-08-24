# Specification conformance record

Status: core implementation and isolated integration profile green, 2026-08-24

## Evidence map

```text
SPEC.md contract
    ├── deterministic unit/contract tests ── 145 passing
    ├── isolated daemon process test ─────── GitHub + hooks + Codex + release + terminal cleanup
    ├── live read-only GitHub validation ─── repository, Project, fields, queries
    └── real target mutation profile ─────── blocked by target prerequisites
```

The 145-test suite is the conformance gate for behavior that Symphony controls. It runs without
network access or user credentials and uses real subprocess boundaries where framing, environment,
signals, or shell behavior matter. The isolated end-to-end profile composes a real workflow store,
GitHub adapter, workspace hooks, Codex JSONL client, agent runner, and orchestrator against
executable fakes. It proves component wiring without pretending that a fake Project is production
evidence.

## Section 17 validation matrix

| Specification area                    | Direct deterministic evidence                                                                                       | Result  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------- |
| 17.1 workflow/config                  | `test/workflow/{definition,loader,config,prompt,store}.test.ts`                                                     | pass    |
| 17.2 workspace/safety                 | `test/workspace/{path-safety,manager}.test.ts`                                                                      | pass    |
| 17.3 tracker adapter                  | `test/tracker/github-projects/{profile,gh-graphql-client,adapter,agent-tools}.test.ts`                              | pass    |
| 17.4 orchestration                    | `test/orchestrator/{eligibility,orchestrator}.test.ts`                                                              | pass    |
| 17.5 Codex client                     | `test/agent/{environment,app-server-client,runner}.test.ts` plus the executable fake app-server                     | pass    |
| 17.6 observability                    | `test/observability/logger.test.ts`, `test/orchestrator/token-accounting.test.ts`, runtime snapshot assertions      | pass    |
| 17.7 CLI/host                         | `test/cli.test.ts`, `test/systemd-unit.test.ts`                                                                     | pass    |
| GitHub agent-tool extension           | GraphQL mutation contract fixtures, exact target authorization, structured failures, and child-secret tests         | pass    |
| harness-owned workspace extension     | teardown ownership, failure retention, partial-create safety, and real empty-directory/adoption spike               | pass    |
| fresh-attempt lifecycle extension     | state versions, strict receipts, one-time workpad reset, refusal-only handoff retry, generation invalidation        | pass    |
| isolated full-daemon integration      | `test/e2e/daemon.test.ts`: Todo → Human Review → released claim → normal-poll Cancelled → guarded `before_remove`   | pass    |
| 17.8 real tracker/target mutation run | live read-only queries succeeded; no disposable target item or safe target worktree contract is currently available | blocked |

The GitHub adapter was also checked read-only against the configured `core` repository and Project
number 28. Repository/Project resolution, the built-in Status field, state-list query shape,
ID-refresh shape, workpad-comment query, and status-mutation schema names/types resolved against
GitHub's live GraphQL schema. No issue, comment, Project item, status, branch, or pull request was
created or changed during that validation.

## Section 18.1 definition of done

| Required capability                            | Implementation boundary and evidence                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| explicit/default workflow path                 | loader + CLI path tests                                                              |
| YAML front matter and Markdown prompt split    | typed parser tests, including CRLF and malformed input                               |
| typed defaults and environment/path resolution | config profile and path-resolution tests                                             |
| required/excluded executor label selectors     | config, eligibility, running-reconcile, and continuation tests                       |
| last-known-good dynamic reload                 | watcher/preflight tests; invalid source preserves reconciliation and blocks dispatch |
| polling with one mutable authority             | serialized orchestrator queue and deterministic fake-clock tests                     |
| state-list and opaque-ID tracker reads         | paginated GitHub adapter contract tests                                              |
| safe collision-resistant workspaces            | 64-bit original-identifier hash and realpath/containment tests                       |
| generation-safe Rework attempts                | fresh receipt, runner, GitHub control, and orchestrator fake-clock tests             |
| all four workspace hooks and timeout           | lifecycle, process-group timeout, and ignored/fatal outcome tests                    |
| Codex app-server subprocess protocol           | generated-contract pin plus JSONL process tests                                      |
| configurable launch command and strict prompt  | config, process launch, and Liquid strict-mode tests                                 |
| continuation and exponential retries           | one-second continuation, 10-second exponential delay, and cap tests                  |
| terminal/non-active reconciliation             | cancellation, release, later normal-poll cleanup, refusal retention, and stall tests |
| startup terminal cleanup                       | complete orchestrator startup sweep assertion                                        |
| structured issue/session logs                  | JSON-lines serializer/fallback tests and orchestration context assertions            |
| operator-visible state                         | stderr logs plus read-only running/retrying/token/rate-limit snapshot                |

The optional HTTP server is not implemented, so its extension profile does not apply. Provider-
native GitHub tools and the `workspace.provider: harness` teardown extension are implemented and
covered as shown above. Retry/session persistence is not implemented; the specification marks it as
a future recommended extension, while required restart recovery remains tracker- and filesystem-
derived.

## Reproduce the gate

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
node dist/cli.js --help
node dist/cli.js --version
```

The recorded run completed 24 test files and 145 tests, produced a clean strict TypeScript build,
printed CLI usage, and reported `symphony 0.1.0`.

## Honest boundary of the evidence

The real integration profile is not counted as passed. Project 28 currently has no items, and the
first target repository's worktree creator/teardown agreement depends on commit `445025a4`, which is
not on `origin/main`. Performing a mutation smoke now would either have no input or validate an
unsafe target state. Once those external prerequisites are resolved, the production gate must use
a disposable issue and record its Project item, workspace receipt, Codex session, pull request,
proof result, terminal cleanup, and absence of tracker credentials in the child environment.
