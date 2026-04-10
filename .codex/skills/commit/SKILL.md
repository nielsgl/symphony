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
- Treat atomicity as a hard default. Vague prompts like `commit everything` or
  `commit all changes` do not authorize bundling unrelated concerns into one
  commit.
- Interpret `commit everything` / `commit all` as "commit all pending work"
  using multiple atomic commits when needed.
- Only treat `single commit`, `one commit`, or `squash into one` as explicit
  authorization for one combined commit.
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
3. Write a commit plan before staging: list each intended commit with message,
   scope, and file/hunk boundaries.
4. Split work into the smallest possible atomic commit unit before staging. If
   changes contain multiple concerns, separate them into multiple commits with
   narrowly scoped diffs.
5. Stage only intended files/hunks for that single atomic unit (prefer targeted
   staging over broad `git add -A` when needed).
6. Sanity-check newly added files; if anything looks random or likely ignored
   (build artifacts, logs, temp files), flag it to the user before committing.
7. If staging is incomplete or includes unrelated files, fix the index or ask
   for confirmation.
8. Choose a Commitizen type and explicit fine-grained scope that match the
   change (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, etc.).
9. Prefix the subject with a matching gitmoji and use Commitizen format, e.g.
   `✨ feat(orchestrator-loop): add retry jitter`.
10. Write a subject line in imperative mood, <= 72 characters, no trailing
   period.
11. Write a body that includes:
    - Summary of key changes (what changed).
    - Rationale and trade-offs (why it changed).
    - Tests or validation run (or explicit note if not run).
12. Wrap body lines at 72 characters.
13. Create the commit message with a here-doc or temp file and use
    `git commit -F <file>` so newlines are literal (avoid `-m` with `\n`).
14. Commit only when the message matches the staged changes: if the staged diff
    includes unrelated files or the message describes work that isn't staged,
    fix the index or revise the message before committing.
15. Repeat the process for the next atomic unit until all intended changes are
    committed.
16. `commit everything` / `commit all` means include all pending work but still
    split by logical concern.
17. Only use a single combined commit when the user explicitly requests
    `single commit`, `one commit`, or `squash into one`.

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
