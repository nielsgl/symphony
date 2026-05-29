---
name: push
description:
  Push current branch changes to origin and create or update the corresponding
  pull request; use when asked to push, publish updates, or create pull request.
---

# Push

## Prerequisites

- `gh` CLI is installed and available in `PATH`.
- `gh auth status` succeeds for GitHub operations in the current repository.
- The current repository's required local validation commands are known from
  project instructions, workflow docs, PR templates, or package scripts.

## Goals

- Push current branch changes to `origin` safely.
- Create a PR if none exists for the branch, otherwise update the existing PR.
- Keep branch history clean when remote has moved.

## Related Skills

- `pull`: use this when push is rejected or sync is not clean (non-fast-forward,
  merge conflict risk, or stale branch).

## Steps

1. Identify current branch and confirm remote state.
2. Run the current repository's required local validation before pushing. If
   the project does not define a validation command, run at least
   `git diff --check` and record that no stronger project-specific command was
   found.
3. Push branch to `origin` with upstream tracking if needed, using whatever
   remote URL is already configured.
4. If push is not clean/rejected:
   - If the failure is a non-fast-forward or sync problem, run the `pull`
     skill to merge `origin/main`, resolve conflicts, and rerun validation.
   - Push again; use `--force-with-lease` only when history was rewritten.
   - If the failure is due to auth, permissions, or workflow restrictions on
     the configured remote, stop and surface the exact error instead of
     rewriting remotes or switching protocols as a workaround.

5. Ensure a PR exists for the branch:
   - If no PR exists, create one.
   - If a PR exists and is open, update it.
   - If branch is tied to a closed/merged PR, create a new branch + PR.
   - Write a proper PR title that clearly describes the change outcome
   - For branch updates, explicitly reconsider whether current PR title still
     matches the latest scope; update it if it no longer does.
6. Write/update PR body with a clear structure:
   - `Summary`: what changed and why.
   - `Verification`: exact commands run and outcomes.
   - Any project-required sections from local workflow docs or PR templates.
   - If PR already exists, refresh body so it reflects total branch scope (not
     just newest commits).
7. If a PR template exists in the target repo, follow it exactly. Otherwise use
   the structured body above.
8. Create or update the PR using the repository's expected PR publication path:
   - If project instructions require a wrapper command, use that wrapper.
   - Otherwise use `gh pr create` or `gh pr edit` with `--body-file`.
9. If body/review text references local generated artifacts such as
   `output/playwright/*`, replace the local path reference with durable review
   evidence before publishing.
10. Reply with the PR URL from `gh pr view`.

## Commands

```bash
# Identify branch
branch=$(git branch --show-current)

# Validation gate. Replace or extend these with the current project's required
# checks when local workflow docs define a different gate.
npm test
npm run build

# Initial push: respect the current origin remote.
git push -u origin HEAD

# If that failed because the remote moved, use the pull skill. After
# pull-skill resolution and re-validation, retry the normal push:
git push -u origin HEAD

# If the configured remote rejects the push for auth, permissions, or workflow
# restrictions, stop and surface the exact error.

# Only if history was rewritten locally:
git push --force-with-lease origin HEAD

# Ensure a PR exists (create only if missing)
pr_state=$(gh pr view --json state -q .state 2>/dev/null || true)
if [ "$pr_state" = "MERGED" ] || [ "$pr_state" = "CLOSED" ]; then
  echo "Current branch is tied to a closed PR; create a new branch + PR." >&2
  exit 1
fi

# Write a clear, human-friendly title that summarizes the shipped change.
pr_title="<clear PR title written for this change>"

# Write/edit PR body to include Summary, Verification, and any
# project-required sections. Use a Git-managed temp path so this works in
# normal repositories and linked worktrees where `.git` may be a file.
# If this repo has a PR template, follow it; otherwise keep the above sections.
# If the project requires a PR wrapper, use it instead of direct gh commands.
pr_body_file=$(git rev-parse --git-path pr-body.md)
cat > "$pr_body_file" <<'MD'
<full markdown PR body>
MD
if [ -z "$pr_state" ]; then
  gh pr create --title "$pr_title" --body-file "$pr_body_file"
else
  # Reconsider title on every branch update; edit if scope shifted.
  gh pr edit --title "$pr_title" --body-file "$pr_body_file"
fi

# Show PR URL for the reply
gh pr view --json url -q .url
```

## Notes

- Do not use `--force`; only use `--force-with-lease` as the last resort.
- Distinguish sync problems from remote auth/permission problems:
  - Use the `pull` skill for non-fast-forward or stale-branch issues.
  - Surface auth, permissions, or workflow restrictions directly instead of
    changing remotes or protocols.
