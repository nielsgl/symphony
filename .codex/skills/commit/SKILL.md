---
name: commit
description:
  Create a well-formed git commit from current changes using session history for
  rationale and summary; use when asked to commit, prepare a commit message, or
  finalize staged work.
---

# Commit

## Goals

- Always produce very small, atomic commits with fine-grained scope.
- Ensure each commit reflects exactly one logical change from the session
  context.
- Follow Commitizen-style git conventions with gitmoji
  (`<gitmoji> <type>(<scope>): <subject>`).
- Include both summary and rationale in the body.

## Inputs

- Codex session history for intent and rationale.
- `git status`, `git diff`, and `git diff --staged` for actual changes.
- Repo-specific commit conventions if documented.

## Steps

1. Read session history to identify scope, intent, and rationale.
2. Inspect the working tree and staged changes (`git status`, `git diff`,
   `git diff --staged`).
3. Split work into the smallest possible atomic commit unit before staging. If
   changes contain multiple concerns, separate them into multiple commits with
   narrowly scoped diffs.
4. Stage only intended files/hunks for that single atomic unit (prefer targeted
   staging over broad `git add -A` when needed).
5. Sanity-check newly added files; if anything looks random or likely ignored
   (build artifacts, logs, temp files), flag it to the user before committing.
6. If staging is incomplete or includes unrelated files, fix the index or ask
   for confirmation.
7. Choose a Commitizen type and explicit fine-grained scope that match the
   change (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, etc.).
8. Prefix the subject with a matching gitmoji and use Commitizen format, e.g.
   `✨ feat(orchestrator-loop): add retry jitter`.
9. Write a subject line in imperative mood, <= 72 characters, no trailing
   period.
10. Write a body that includes:
    - Summary of key changes (what changed).
    - Rationale and trade-offs (why it changed).
    - Tests or validation run (or explicit note if not run).
11. Wrap body lines at 72 characters.
12. Create the commit message with a here-doc or temp file and use
    `git commit -F <file>` so newlines are literal (avoid `-m` with `\n`).
13. Commit only when the message matches the staged changes: if the staged diff
    includes unrelated files or the message describes work that isn't staged,
    fix the index or revise the message before committing.
14. Repeat the process for the next atomic unit until all intended changes are
    committed.

## Output

- One or more very small, atomic commits created with `git commit`.
- Every commit message must use Commitizen style with gitmoji and a
  fine-grained scope.

## Template

Type and scope are examples only; adjust to fit the repo and changes.

```
<gitmoji> <type>(<scope>): <short summary>

Summary:
- <what changed>
- <what changed>

Rationale:
- <why>
- <why>

Tests:
- <command or "not run (reason)">

```
