# Repository Guidelines

## Project Structure & Module Organization
This repo is currently specification-first.
- `README.md`: project overview.
- `SPEC.md`: canonical Symphony service spec (architecture, domain model, runtime behavior).
- `.codex/skills/linear-graphql/SKILL.md`: raw Linear GraphQL helper.
- `.codex/skills/commit/SKILL.md`: required commit workflow.

The initial implementation structure is locked at top level as `src/`, `tests/`, and `scripts/`.
This top-level baseline is frozen for v1 unless governance approves a structural change.
Keep module boundaries aligned with `SPEC.md` components and mirror test coverage by subsystem.

Repository structure baseline mapping:
- `src/orchestrator/`, `src/workflow/`, `src/workspace/`, `src/codex/`, `src/tracker/`, `src/security/`, `src/persistence/`, `src/observability/`, `src/runtime/`, `src/api/`
- `tests/` mirrors major `src/` subsystem areas.
- `scripts/` contains build, launch, and smoke-test automation.

Structural changes to top-level directories require governance approval and
must include updates in `docs/prd/STATUS.md` plus aligned PRD references in the
same change.

## Build, Test, and Development Commands
Primary validation commands:
- `npm test` - run the automated test suite.
- `npm run build` - validate TypeScript build output.

Baseline hygiene checks:
- `git status` - confirm intended changes.
- `rg --files` - inspect repository structure quickly.
- `git diff --check` - catch whitespace/merge-marker issues.

## Dependency Management
- Add dependencies using package manager commands, not manual `package.json` edits.
- Runtime deps: use `npm add <pkg>` or `pnpm add <pkg>`.
- Dev deps: use `npm add -D <pkg>` or `pnpm add --dev <pkg>`.
- Never add/remove/update dependency entries directly in `package.json`.

## Coding Style & Naming Conventions
- Reuse `SPEC.md` terminology (`Orchestrator`, `Workspace Manager`, `Run Attempt`).
- Prefer descriptive names over abbreviations.
- Keep docs concise: short sections, explicit headings, actionable bullets.
- Prefer ASCII unless the file already requires Unicode.

## Testing Guidelines
- Run `npm test` and `npm run build` for every change unless explicitly scoped otherwise.
- Validate behavior against relevant `SPEC.md` sections.
- Document manual verification steps and outputs in PRs.
- Add or update automated tests alongside runtime code changes.

## Commit, Merge & Pull Request Guidelines
Follow `.codex/skills/commit/SKILL.md` for every commit.
- The commit skill workflow is mandatory whenever creating commits.
- Very small, atomic commits are a hard repository rule and override vague prompts like
  `commit everything` or `commit all changes`.
- Make very small, atomic commits: one logical change per commit.
- Use fine-grained scopes (for example `orchestrator-loop`, `workspace-manager`).
- Use Commitizen + gitmoji format: `<gitmoji> <type>(<scope>): <subject>`.
- Example: `✨ feat(orchestrator-loop): add retry jitter`.
- Include commit body sections for summary, rationale, and tests.
- Before committing, list a commit plan (intended commit message + file/hunk scope) and then
  stage only that atomic unit.
- Do not use broad staging (`git add -A`) for mixed logical changes.
- If changes span multiple concerns, split into multiple commits by default.
- `commit everything` / `commit all` means commit all pending work as multiple atomic commits, not
  one combined commit.
- Only create a single combined commit when the user explicitly says `single commit`, `one commit`,
  or `squash into one`.

Merge policy:
- Always merge with `--no-ff` to preserve branch history.
- Example: `git merge --no-ff <branch>`.

PR requirements:
- Explain what changed and why.
- Reference relevant `SPEC.md` section(s).
- Include verification evidence (commands, output, screenshots when relevant).

## Agent Skills To Use
Use these skills when applicable:
- `land`: land PRs with merge-commit strategy and CI/review watch loops.
- `pull`: sync feature branches with `origin/main` using merge (no rebase, `--no-ff`).
- `push`: push branch updates and create/update PRs with Symphony validation gates.
- `frontend-skill`: visually strong UI/UX work.
- `linear`: Linear issue/project triage and updates.
- `playwright`: CLI browser automation and screenshots.
- `playwright-interactive`: persistent `js_repl` Playwright/Electron debugging.
