# Specification conformance record

Status: compatibility profile plus managed governance/state/repository/preparation/delivery and
manual WorkSession control green, 2026-08-27; protected real pilot pending

> [!IMPORTANT]
> Passing evidence below distinguishes Symphony-controlled implementation proof from the remaining
> estate integration gate. Accepted-governance resolution, the WorkSession store, repository and
> preparation drivers, lane-aware orchestration, durable delivery, and host-authenticated WCP
> workflow/artifact correlation plus manual start/attach/plan/steer/status have direct local
> evidence. The final accepted-publication repin and a composed Dyslexify pilot remain unproven here.

## Evidence map

```text
SPEC.md contract
    ├── deterministic unit/contract tests ── 297 passing + 1 host-dependent skip
    ├── isolated legacy daemon test ───────── GitHub + hooks + Codex + terminal cleanup
    ├── isolated managed daemon test ──────── governance + binding + SQLite + worktree + pnpm + Codex
    ├── real Git/process fixtures ─────────── restart, fencing, refusal, cleanup
    ├── manual process journey ────────────── five fresh CLIs + binding + Git attach + SQLite reopen
    ├── opt-in host scope probe ───────────── detached descendant + cgroup quiescence
    ├── live read-only GitHub validation ─── repository, Project, fields, queries
    └── protected target mutation profile ── final publication repin + Dyslexify journey pending
```

The deterministic suite is the conformance gate for behavior that Symphony controls. It runs without
network access or user credentials and uses real subprocess boundaries where framing, environment,
signals, or shell behavior matter. The isolated end-to-end profile composes a real workflow store,
GitHub adapter, SQLite state, both repository-driver routes, real temporary Git repositories,
sandboxed pnpm, Codex JSONL client, agent runner, and orchestrator against executable fakes. It
proves component wiring without pretending that a fake Project is production evidence.

## Section 17 validation matrix

| Specification area                 | Direct deterministic evidence                                                                                                                   | Result  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 17.1 workflow/config               | workflow tests plus `test/deployment/resolver.test.ts`: exact profile/context, separate binding authority, and exact preparation-class matching | pass    |
| accepted governance                | strict manifest/policy parsing; exact checkout identity, ancestry, Git blobs/digests, drift, and product-policy equality fixtures               | pass    |
| 17.2 durable state                 | `test/state/sqlite-store.test.ts`: private first-open DB/WAL/SHM, v1→v2 migration/rollback, revision + lease fences, conflicts, effects, backup | pass    |
| 17.2 repository/workspace safety   | `test/workspace/*`, `test/repository/git-worktree-driver.test.ts`: real Git allocation/recovery/fresh/cleanup fixtures                          | pass    |
| 17.2 preparation                   | `test/preparation/pnpm-driver.test.ts`: real offline pnpm/bwrap, source/integrity admission, network/env/path isolation, descendant teardown    | pass    |
| 17.3 tracker adapter               | `test/tracker/github-projects/{profile,gh-graphql-client,adapter,agent-tools}.test.ts`                                                          | pass    |
| 17.4 orchestration                 | orchestrator tests, including quiescence-before-expiry and retained-lease refusal                                                               | pass    |
| 17.5 Codex client                  | agent tests plus exact systemd-scope wrapper/refusal fixtures and executable fake app-server                                                    | pass    |
| 17.6 observability                 | `test/observability/logger.test.ts`, `test/orchestrator/token-accounting.test.ts`, runtime snapshot assertions                                  | pass    |
| 17.7 CLI/host                      | daemon lifecycle plus five-command parsing/execution, exact binding, restart, status/privacy, and systemd unit tests                            | pass    |
| manual WorkSession control         | `test/interactive/*` plus `test/e2e/manual-worksession.test.ts`: hostile operations and five-fresh-process real CLI journey                     | pass    |
| GitHub agent-tool extension        | GraphQL mutation contract fixtures, exact target authorization, structured failures, and child-secret tests                                     | pass    |
| legacy harness workspace extension | teardown ownership, failure retention, partial-create safety, and real empty-directory/adoption spike                                           | pass    |
| fresh-attempt lifecycle extension  | legacy receipt tests plus managed state/generation/outbox/restart fixtures                                                                      | pass    |
| lane-aware delivery extension      | policy/fact intersection, exact PR/check plus pinned GitHub/WCP run proof, restart effects, safe Rework abandonment, and Done                   | pass    |
| isolated legacy daemon journey     | `test/e2e/daemon.test.ts`: Todo → Human Review → released claim → normal-poll Cancelled → guarded compatibility cleanup                         | pass    |
| isolated managed daemon journey    | accepted profile/binding, hostile mutable profile ignored, no hooks, separate state, exact runtime, guarded cleanup                             | pass    |
| host descendant-boundary probe     | `SYMPHONY_SYSTEMD_INTEGRATION=1`: detached child survives app-server exit and is removed by the exact user scope                                | pass    |
| 17.8 protected target mutation run | external WCP evidence inspected; final accepted repin and composed disposable Dyslexify journey remain                                          | pending |

The GitHub adapter was also checked read-only against the configured `core` repository and Project
number 28. Repository/Project resolution, the built-in Status field, state-list query shape,
ID-refresh shape, workpad-comment query, and status-mutation schema names/types resolved against
GitHub's live GraphQL schema. No issue, comment, Project item, status, branch, or pull request was
created or changed during that validation.

## Section 18.1 definition of done

| Required capability                              | Implementation boundary and evidence                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| managed binding / compatibility path selection   | exact `--binding`; positional/default workflow refuses managed Git                                                          |
| accepted-governance composition                  | strict v3 binding, publication ancestry/blobs, typed policy and WCP trust snapshots, legacy Attempt fence                   |
| YAML front matter and Markdown prompt split      | typed parser tests, including CRLF and malformed input                                                                      |
| typed defaults and environment/path resolution   | config profile and path-resolution tests                                                                                    |
| required/excluded executor label selectors       | config, eligibility, running-reconcile, and continuation tests                                                              |
| last-known-good dynamic reload                   | watcher/preflight tests; invalid source preserves reconciliation and blocks dispatch                                        |
| durable WorkSession authority                    | private SQLite store, v2 migration, revisions, attachments, leases, sagas, outbox                                           |
| polling with one application authority           | serialized orchestrator queue over the store and deterministic fake-clock tests                                             |
| lane-aware authoring/delivery reconciliation     | existing-session policy pinning, delivery-only lanes, product-grant intersection, and typed Done effect                     |
| state-list and opaque-ID tracker reads           | paginated GitHub adapter contract tests                                                                                     |
| safe collision-resistant workspaces              | directory keys plus managed branch/worktree identity and containment tests                                                  |
| generation-safe Rework attempts                  | compatibility receipts plus managed leases/outbox/restart tests                                                             |
| managed repository lifecycle                     | real-Git create, reuse, crash recovery, dirty retention, and exact cleanup fixtures                                         |
| managed Codex authoring boundary                 | fixed executable/policy/private temp/scope, descendant proof, retained-lease tests                                          |
| sandboxed pnpm preparation                       | frozen offline real install, strict inputs/integrities, read-only seed, private cache, network/path/env and teardown probes |
| all four workspace hooks and timeout             | lifecycle, process-group timeout, and ignored/fatal outcome tests                                                           |
| Codex app-server subprocess protocol             | generated-contract pin plus JSONL process tests                                                                             |
| strict accepted prompt and compatibility command | exact-revision context fixture; configurable shell command is compatibility-only                                            |
| continuation and exponential retries             | one-second continuation, 10-second exponential delay, and cap tests                                                         |
| terminal/non-active reconciliation               | cancellation, release, later normal-poll cleanup, refusal retention, and stall tests                                        |
| startup terminal cleanup                         | complete orchestrator startup sweep assertion                                                                               |
| durable GitHub/WCP delivery                      | pinned event/caller/control SHA, exact source/PR/check/artifacts, CAS refs, merge bounds, restart/Rework fixtures           |
| structured issue/session logs                    | JSON-lines serializer/fallback tests and orchestration context assertions                                                   |
| operator-visible state                           | stderr logs plus read-only running/retrying/token/rate-limit snapshot                                                       |
| manual boardless state                           | exact-binding local CLI, current plan, append-only steering, human attachment, bounded human/JSON status                    |

The optional HTTP server is not implemented, so its extension profile does not apply. Provider-
native GitHub tools and the legacy `workspace.provider: harness` teardown extension remain covered,
but that does not make the hook path the target integration model. WorkSession/attempt/retry and
managed-workspace persistence is implemented; tracker and Git/filesystem observations are now
reconciliation inputs, not substitute state owners. New managed Attempts require a non-null
accepted doctrine/manifest/policy snapshot. Historical version-1/version-2 records with null
governance remain readable but cannot be silently upgraded or executed.

## Reproduce the gate

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
node dist/cli.js --help
node dist/cli.js --version
node dist/cli.js work --help
```

The 2026-08-27 manual-control gate completed 43 passing test files plus one host-dependent skipped
file: 297 tests passed and one skipped. The strict TypeScript build passed, daemon and manual CLI
usage rendered, and the version command reported `symphony 0.1.0`. Enabling the skipped systemd
integration remains a separate host probe. This supersedes the 2026-08-26 governance/delivery
checkpoint of 272 passing tests plus the same host-dependent skip.

A separate design probe against installed `codex-cli 0.147.0` used app-server `command/exec` with
the exact managed policy. It could write inside the linked Attempt but could not run `git
update-ref` against the shared source repository, and the ref remained absent. A control probe that
left ordinary `/tmp` writable did update a source repository also located under `/tmp`; this is why
managed policy excludes ambient `/tmp` and supplies one private runtime temp root. This manual probe
supports the design but is not counted as a portable CI test.

The process-lifetime half is now reproducible separately with
`SYMPHONY_SYSTEMD_INTEGRATION=1 pnpm exec vitest run
test/agent/systemd-user-scope.integration.test.ts`. On this host it launched an app-server parent,
created a detached `sleep` descendant, proved the descendant survived parent exit, and then proved
the configured systemd user scope removed it. The default suite skips this host-dependent probe;
the deterministic scope, orchestration-order, and retained-lease tests remain mandatory everywhere.

## Honest boundary of the evidence

The real integration profile is not counted as passed. WCP proof v2, Symphony's durable
governance/delivery consumers, and deterministic manual control exist, but the final Spec 001
publication has not yet been repinned and the components have not completed one disposable
Dyslexify journey together. After that repin, the
production gate must record the Project item, WorkSession/Attempt, pinned doctrine/manifest/policy,
workspace lease, base/head SHAs, Codex correlation, protected plan/result/run/check identities, pull
request, terminal cleanup, and absence of tracker/delivery credentials in candidate execution.
