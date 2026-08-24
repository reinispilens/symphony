# Workspace bootstrap spike — 2026-08-23

## Question map

```text
configurable root? ── yes ─┐
empty target accepted? ─ yes ─┼── the hook-based worktree design is viable
fresh worktree adoptable? yes ┘
directory key = branch? no ───── keep branch policy in the repository harness
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
subsequent allocator can observe ownership.

## Design consequences

The result validates the filesystem window, not the original hook command. An `after_create` hook
runs in the empty workspace, so bare `pnpm harness:prepare` has no package manifest from which to
resolve the script. The bootstrap command must address a repository-owned entry point through a
generic environment variable while retaining the empty workspace as `cwd`.

Workspace keys and branches also require separate contracts. Symphony permits `[A-Za-z0-9._-]` in
directory keys, while Git rejects some sequences composed entirely of those characters, such as
`..` and a `.lock` suffix. Symphony owns only the deterministic directory key. The repository
harness owns branch naming, fetch/base-SHA selection, allocation, and its durable receipt.

The implemented `workspace.provider: harness` mode follows that ownership through teardown. It
requires `after_create` and `before_remove`; the latter must remove the workspace itself. If it
fails or leaves any entry at the path, Symphony logs and retains that entry instead of applying a
generic recursive delete. The default `directory` provider retains the core-spec behavior in which
Symphony deletes the contained directory after the non-fatal `before_remove` hook.

## What this spike does not prove

- It does not prove `445025a4` is on `origin/main`; it is not.
- It used `--no-install`, so it does not measure dependency installation or package-build time.
- It proves one isolated allocation, not capacity under concurrent daemons.
- It does not prove teardown, restart recovery, or the four-valued proof contract; each needs a
  separate integration gate.
