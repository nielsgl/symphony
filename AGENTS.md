# Repository Guidelines

## Project Structure & Module Organization
This repo is currently specification-first.
- `README.md`: project overview.
- `SPEC.md`: canonical Symphony service spec (architecture, domain model, runtime behavior).
- `.codex/skills/linear-graphql/SKILL.md`: raw Linear GraphQL helper.
- `.codex/skills/commit/SKILL.md`: required commit workflow.

There is no `src/` or `tests/` tree yet. When adding implementation code, use clear top-level folders (for example `src/`, `tests/`, `scripts/`) and keep module boundaries aligned with `SPEC.md` components.

## Build, Test, and Development Commands
No build/test pipeline is committed yet. Baseline checks:
- `git status` - confirm intended changes.
- `rg --files` - inspect repository structure quickly.
- `git diff --check` - catch whitespace/merge-marker issues.

If you introduce a toolchain, add concrete commands (for example `npm test`, `make build`) in the same PR.

## Coding Style & Naming Conventions
- Reuse `SPEC.md` terminology (`Orchestrator`, `Workspace Manager`, `Run Attempt`).
- Prefer descriptive names over abbreviations.
- Keep docs concise: short sections, explicit headings, actionable bullets.
- Prefer ASCII unless the file already requires Unicode.

## Testing Guidelines
No test framework is configured yet.
- Validate behavior against relevant `SPEC.md` sections.
- Document manual verification steps and outputs in PRs.
- Add automated tests alongside new runtime code once a harness exists.

## Commit, Merge & Pull Request Guidelines
Follow `.codex/skills/commit/SKILL.md` for every commit.
- Make very small, atomic commits: one logical change per commit.
- Use fine-grained scopes (for example `orchestrator-loop`, `workspace-manager`).
- Use Commitizen + gitmoji format: `<gitmoji> <type>(<scope>): <subject>`.
- Example: `✨ feat(orchestrator-loop): add retry jitter`.
- Include commit body sections for summary, rationale, and tests.

Merge policy:
- Always merge with `--no-ff` to preserve branch history.
- Example: `git merge --no-ff <branch>`.

PR requirements:
- Explain what changed and why.
- Reference relevant `SPEC.md` section(s).
- Include verification evidence (commands, output, screenshots when relevant).

## Agent Skills To Use
Use these skills when applicable:
- `frontend-skill`: visually strong UI/UX work.
- `linear`: Linear issue/project triage and updates.
- `playwright`: CLI browser automation and screenshots.
- `playwright-interactive`: persistent `js_repl` Playwright/Electron debugging.
