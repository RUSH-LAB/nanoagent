---
name: production-pr
description: Open the release pull request from `devmode` into `production`, the branch Railway deploys. Use when the user wants to ship, release, deploy, or "open a PR to production".
---

# Open a pull request into production

`production` in `RUSH-LAB/nanoagent` is what Railway runs. Merging into it
deploys Mochi (`helpinghands/`) and/or NanoAgent (`nanoagent/`), whichever
directory changed. The rules are in `helpinghands/docs/infra/release-policy.md`;
read it before starting.

This skill opens the pull request. It never merges: merging deploys, so only
merge when the user explicitly asks in this conversation.

Stop and report at the first step that fails. Never work around a failure.

## 1. Check the branch

```bash
git fetch origin
git branch --show-current
git status --short
```

- The current branch must be `devmode`, the only branch released into
  `production`. Any other branch goes into `devmode` first, in a pull request
  with `--base devmode`.
- Uncommitted and untracked files do not ship. If there are any, list them and
  ask whether to commit them first. Never commit or stash on your own.
- The branch must be pushed with nothing missing from either side:
  `git rev-list --left-right --count origin/<branch>...HEAD` must print `0 0`.
  If the branch is ahead, ask before pushing. If it is behind, stop.

## 2. Inspect what would deploy

```bash
git log --oneline origin/production..HEAD
git diff --stat origin/production...HEAD
```

If there are no commits, stop: there is nothing to release.

Record:

- **Services:** Mochi if anything under `helpinghands/` changed, NanoAgent if
  anything under `nanoagent/` changed.
- **Migrations:** new files under `helpinghands/src/server/postgres/migrations/`.
  Railway applies them before the new Mochi container starts, and they are not
  rolled back with the image.
- **Contract:** changes under `nanoagent/src/nanoagent/web/` or
  `nanoagent/deploy/railway/profiles/`. If any of these changes the `/v1` HTTP/SSE
  contract incompatibly, or renames or removes a profile ID, *and* Mochi also
  changed, stop. The policy requires releasing NanoAgent alone first; tell the
  user how to split the branch.

## 3. Reuse an open pull request

```bash
gh pr list --repo RUSH-LAB/nanoagent --base production --head <branch> --state open
```

If one exists, don't open another. Report its URL and go to step 5.

## 4. Open the pull request

Write the body to a temp file and run:

```bash
gh pr create --repo RUSH-LAB/nanoagent --base production --head <branch> \
  --title "<one-line summary of the release>" --body-file <file>
```

The body, written for whoever reviews and merges it:

```markdown
## What ships
<one bullet per user-visible change, grouped by service>

## Services redeployed
- Mochi: yes/no
- NanoAgent: yes/no

## Migrations
<each new migration file and what it changes, or "None">

## After merging
- [ ] Railway health check passes for each redeployed service
- [ ] NanoAgent: `/health` and `/v1/profiles` respond (if redeployed)
- [ ] Mochi: sign-in, profile discovery, one streamed assistant response
- [ ] If anything fails, roll back Mochi first, then NanoAgent, to the previous
      successful Railway deployment
```

## 5. Report

```bash
gh pr checks <number> --repo RUSH-LAB/nanoagent
```

Give the user the PR URL, the services it redeploys, any migrations, and the CI
state. If a check fails, show its name and link. Remind the user that merging
deploys.
