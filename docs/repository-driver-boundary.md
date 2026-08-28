# Repository driver boundary

Status: implemented for managed Git worktrees; legacy hook-based workflows remain compatibility
only, 2026-08-28.

## The boundary in one picture

```text
product repository                    Symphony operator
profile + prompt + tests              binding + credentials + host paths
             └──────────────┬──────────────┘
                            ▼
                    Symphony WorkSession
                            │
             ┌──────────────┼───────────────┐
             ▼              ▼               ▼
      managed worktree   Codex runtime   pull request + CI
             └──────────────┴───────────────┘
                            ▼
                       safe cleanup
```

Symphony owns repository lifecycle and its durable state. A product integration is a thin,
declarative profile. It names repository facts and required checks; it does not implement branches,
worktrees, retries, delivery, or cleanup.

## Ownership

| Concern             | Product repository                      | Symphony                                                   | External provider                                   |
| ------------------- | --------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| Product behavior    | code, tests, domain meaning             | does not reinterpret it                                    | executes or reports configured work                 |
| Repository identity | canonical identity and allowed base ref | verifies origin and pins the base commit                   | hosts the repository                                |
| Host binding        | no machine-specific paths               | binds source, state, workspace, tools, and credentials     | supplies host or service capacity                   |
| Worktree lifecycle  | no lifecycle implementation             | allocates, verifies, recovers, and removes                 | none                                                |
| Preparation         | manifests and lockfiles                 | runs the selected built-in preparation driver              | may supply read-only package bytes                  |
| Delivery            | required check names and merge profile  | records exact branch, head, PR, checks, merge, and cleanup | performs GitHub operations and reports check status |
| Durable state       | no mutable orchestration state          | owns WorkSessions, Attempts, leases, sagas, and recovery   | exposes observable external facts                   |

## Thin product profile

The profile may declare:

- repository identity and allowed base ref;
- accepted prompt and context paths;
- one preparation class implemented by Symphony;
- a delivery authority profile and ordinary required-check names.

It must not:

- resolve or store the immutable base commit;
- create, reset, or delete branches and worktrees;
- implement retries, waits, recovery, pull-request coordination, or cleanup;
- select host paths, executables, credentials, or concurrency;
- expose Symphony or provider credentials to candidate execution.

## Durable lifecycle

```text
record intent → allocate and verify worktree → prepare → run Codex
      → materialize immutable commit → push/open PR
      → observe every required check on that exact commit
      → merge only when the product grant and current lane both allow it
      → release the exact remote branch → verify and remove the worktree
```

Every external mutation has a durable intent and idempotency key. After a crash, Symphony reads its
own state, observes the external system, and resumes or refuses. It never asks candidate code to
reconstruct authority.

The delivery provider runs separately with operator credentials. Its request contains the pinned
product grant, current tracker authority, repository identity, exact branch/base/head, and no
credential values. A check from another commit cannot satisfy delivery.

## Compatibility boundary

The existing `directory` and hook-owned workspace routes remain readable for existing workflows.
They are not the integration model for new repositories. New targets use the managed Git driver and
must not add repository scripts that create or delete Symphony workspaces.

## Acceptance rules

The boundary is sound when:

1. a repository can be onboarded with a thin profile and product-owned tests;
2. Symphony can recover allocation, delivery, and cleanup from its WorkSession store;
3. candidate changes cannot alter the pinned base commit, host binding, credentials, or cleanup
   target;
4. removal requires the matching controller generation and workspace lease, no active runtime,
   root containment, and independent Git/filesystem verification; and
5. `pnpm check` and `pnpm build` pass.
