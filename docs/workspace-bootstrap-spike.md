# Workspace bootstrap spike — 2026-08-23

Status: historical feasibility evidence; its repository-harness ownership conclusion is superseded
by [`repository-driver-boundary.md`](repository-driver-boundary.md)

## Question map

```text
configurable root? ── yes ─┐
empty target accepted? ─ yes ─┼── Symphony can own a Git-worktree driver
fresh worktree adoptable? yes ┘
directory key = branch? no ───── keep separate path and branch contracts in Symphony
```

## Evidence

`SPEC.md` section 5.3.3 defines `workspace.root`, including absolute normalization, `~` expansion,
`$VAR` resolution, and workflow-directory-relative paths. The workspace estate can therefore be
configured per repository without hardcoding a path in Symphony.

A disposable local clone of `core` at `445025a4` exercised the actual sequence:

1. Create an empty destination directory.
2. Run `git worktree add -b symphony-spike/SYM-123 <empty-destination> HEAD`.
3. Immediately run the unmodified `scripts/worktree-new.mjs --adopt <destination> --no-install`.

The command returned the following positive facts before the disposable clone was removed:

```text
Adopting worktree
  branch  symphony-spike/SYM-123
  lane    1 (0 lanes already held)

assert-worktree-resolution: nothing resolves outside this worktree
SPIKE_RESULT branch=symphony-spike/SYM-123 lane=1 registered_worktrees=2
```

This proves that Git accepts an already-existing empty destination and that `core` adoption accepts
a worktree registered only seconds earlier. `--adopt` also records the lane before returning, so a
subsequent allocator can observe ownership. The evidence supports a central Git-worktree driver;
it does not require each target repository to implement that driver.

## Design consequences

The result validates the filesystem window, not the original hook command. In the current
compatibility path an `after_create` hook runs in the empty workspace, so bare
`pnpm harness:prepare` has no package manifest from which to resolve the script. That observation
explains the legacy explicit entry point; it is no longer a recommendation for new integrations.

Workspace keys and branches also require separate contracts. Symphony permits `[A-Za-z0-9._-]` in
directory keys, while Git rejects some sequences composed entirely of those characters, such as
`..` and a `.lock` suffix. The target adapter may declare branch policy, but Symphony must own both
safe name generation and the resulting durable lifecycle record.

The implemented `workspace.provider: harness` mode remains compatibility behavior. It requires
`after_create` and `before_remove`; the latter must remove the workspace itself. If it fails or
leaves any entry at the path, Symphony logs and retains that entry instead of applying a generic
recursive delete. The Symphony-owned Git-worktree driver now preserves that safe
refusal while moving implementation and lease authority out of the target repository. Real-Git
fixtures cover allocation-before-effect, recovery, generation replacement, and guarded removal;
managed delivery and a real product pilot remain separate evidence.

## What this spike does not prove

- It does not prove `445025a4` is on `origin/main`; it is not.
- It used `--no-install`, so it does not measure dependency installation or package-build time.
- It proves one isolated allocation, not capacity under concurrent daemons.
- It does not prove teardown, restart recovery, or the four-valued proof contract; each needs a
  separate integration gate.
