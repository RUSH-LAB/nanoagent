---
name: git-commit
description: 'Execute git commit with conventional commit message analysis, intelligent staging, and message generation. Use when user asks to commit changes, create a git commit, or mentions "/commit". Supports: (1) Auto-detecting type and scope from changes, (2) Generating conventional commit messages from diff, (3) Interactive commit with optional type/scope/description overrides, (4) Intelligent file staging for logical grouping'
license: MIT
---

# Git Commit with Conventional Commits

## Format

```
<type>[optional scope]: <description>

[optional body]
```

Types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`

Breaking changes: add `!` after type/scope (e.g. `feat!: remove deprecated endpoint`)

## Workflow

### 1. Start from parent repo root

```bash
cd /path/to/parent/repo
git status
git diff
```

Use `git status` (NOT `--porcelain`) to see submodule annotations like `(modified content)`, `(new commits)`, `(untracked content)`.

### 2. Handle ALL submodule changes FIRST

When `git status` shows modified submodules, handle ALL in one pass. Do NOT commit some and leave others.

**Submodule annotations:**
- `(modified content)` / `(untracked content)` — dirty: uncommitted changes INSIDE
- `(new commits)` — committed inside, but parent pointer is stale

**For dirty submodules, commit inside first:**

IMPORTANT: The submodule's git root may NOT be the deepest directory (e.g. `submodules/public/mochi-lab` is the git root, but code lives in `submodules/public/mochi-lab/mochi-lab/`). Always `cd` to the git root (where `.git` is).

```bash
cd submodules/path/to/submodule   # the git root!
git status
git diff
git add <files>
git commit -m "<type>: <description>"
git push
```

**After ALL submodules are committed and pushed, update parent:**

```bash
cd /path/to/parent/repo
git add submodules/sub1 submodules/sub2
git commit -m "build: update sub1 to <hash> and sub2 to <hash>"
git push origin HEAD
```

**NEVER leave a submodule with `(modified content)` or `(new commits)` unhandled.**

### 3. Stage regular files

```bash
git add path/to/file1 path/to/file2
```

**Never commit secrets** (.env, credentials.json, private keys).

### 4. Generate commit message

- **Type**: What kind of change?
- **Scope**: What area/module affected?
- **Description**: Present tense, imperative mood, <72 chars

### 5. Commit

```bash
git commit -m "$(cat <<'EOF'
<type>[scope]: <description>

<optional body>
EOF
)"
```

### 6. Push

Push only repos you actually committed to. Push submodules before the parent.

```bash
git push origin HEAD
```

If no upstream yet: `git push -u origin HEAD`

## Best Practices

- One logical change per commit
- Present tense, imperative mood: "add feature" not "added feature"
- Description under 72 characters

## Safety

- NEVER update git config
- NEVER run destructive commands (--force, hard reset) without explicit request
- NEVER skip hooks (--no-verify) unless user asks
- NEVER force push to main/master
- If commit fails due to hooks, fix and create NEW commit (don't amend)
