# Symphony Project Adoption and Distribution Plan

Status: Draft planning artifact, local-first review incorporated
Purpose: Define what is necessary to make Symphony easy to use across local projects first, then distribute later, without losing the current repo-owned workflow model or the internal workflow that works well for building Symphony itself.

## Executive Summary

Symphony already has the core runtime shape needed for multi-project use:

- `WORKFLOW.md` is repo-owned policy, as required by `SPEC.md`.
- `scripts/start-project-dashboard.sh` can run this checkout against another repository.
- Workflow preset examples exist for Linear and GitHub.
- Workspace provisioning supports `worktree`, `clone`, and `none`.
- Runtime defaults derive persistence from the workflow directory.
- The desktop backend can be bundled as a sidecar for packaged desktop usage.

The current friction is local ergonomics and configuration boundaries first, product packaging second. The working command:

```bash
npm --prefix /Users/niels.van.Galen.last/code/symphony run start:dashboard -- --workflow="$PWD/WORKFLOW.md" --port=61026 --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

proves the runtime can already target other projects. The first work needed is to turn that into a small, memorable local-checkout experience:

```bash
symphony doctor
symphony dashboard
symphony init
```

The recommended path is:

1. Add a local-first CLI entrypoint that can be linked from the current checkout.
2. Preserve the current Symphony-internal workflow as a golden profile, not as a generic default.
3. Add project profiles that materialize complete `WORKFLOW.md` files for other repositories.
4. Support project-local customization with explicit precedence, diagnostics, and no hidden inheritance at runtime.
5. Package and distribute only after local multi-project use is proven.
6. Keep `WORKFLOW.md` as the canonical effective contract, even if future tooling can generate it from profiles.

Critical audit findings from 2026-05-11:

- The unscoped npm package name `symphony` is already occupied by an unrelated package. Use a scoped package such as `@nielsgalen/symphony` while still installing a `symphony` binary.
- The current repository has no `package.json` `bin` or `files` allowlist. `npm pack --dry-run` currently includes source/tests/docs/internal skills and omits `dist/` because npm falls back to `.gitignore`.
- The existing desktop sidecar builder uses deprecated `vercel/pkg` and targets Node 18, which is already end-of-life. That path can remain legacy implementation evidence, but it is not a sound future distribution strategy.
- High-trust local-run acknowledgement must not be suppressible by project-committed config. A malicious or careless project could otherwise hide the trust boundary.

Priority clarification from 2026-05-11:

- The near-term goal is not npm naming, Homebrew, or public distribution.
- The near-term goal is fast, reliable local use across multiple projects from one Symphony checkout.
- The existing setup for building Symphony itself is valuable and must remain intact.
- Generic project profiles should not water down the Symphony-internal workflow; they should sit beside it.

## Current State

### What Already Works

| Area | Current evidence | Implication |
|---|---|---|
| Runtime against another repo | `README.md` documents `npm run start:project-dashboard -- ../symphony-todo-app`; `scripts/start-project-dashboard.sh` resolves `<app-repo>/WORKFLOW.md`. | Symphony is not tied to its own repo at runtime. |
| Workflow contract | `SPEC.md` defines repo-owned `WORKFLOW.md`; `WORKFLOW.example.md` documents supported keys. | Cross-project use should preserve project-owned workflow policy. |
| Tracker variability | Linear, GitHub, and memory trackers exist. | Project profiles can start with Linear/GitHub examples, with memory as local demo/dev mode. |
| Workspace variability | `workspace.provisioner.type` supports `none`, `worktree`, and `clone`. | Project setup can choose isolation strategy by repo type. |
| Toolchain variability | Hooks are arbitrary shell commands; existing examples show Node install/build commands. | Language-specific setup can live in profiles or generated hooks without changing core runtime. |
| Runtime env overrides | `README.md` documents `SYMPHONY_CODEX_HOME`, model, reasoning, flags, port, workflow path, `.env` loading. | Defaults can be made easier through CLI flags and init prompts. |
| Desktop distribution basis | `build:desktop` bundles `symphony-backend` sidecar. | Desktop packaging is a separate distribution surface, not a blocker for CLI MVP. |

### What Is Still Hard

- Startup requires knowing the Symphony checkout path and npm command shape.
- `package.json` has no `bin` entry, so `symphony` is not available as a command.
- There is no local install/link command that creates a stable `symphony` executable pointing at this checkout.
- There is no explicit profile model that distinguishes "build Symphony itself" from "operate another project."
- The package name `symphony` is occupied on npm by an unrelated package.
- `package.json` has no `files` allowlist or publish contract.
- Current `npm pack --dry-run` output is not a viable package: it includes source/tests/docs/internal skills and misses compiled `dist/`.
- The guardrail acknowledgement flag is intentionally explicit but ergonomically noisy.
- Current preset examples are not discoverable local project profiles.
- `WORKFLOW.md` generation is manual.
- Project-specific paths inside examples still need hand editing.
- Skill usage is mostly embedded in a Symphony-specific `WORKFLOW.md`, not packaged as reusable defaults.
- There is no `doctor` command that validates auth, workflow config, Codex availability, git/worktree safety, ports, and hook readiness before starting.
- There is no clear precedence model for global defaults, built-in profiles, project overrides, and user-local overrides.
- `scripts/build-desktop-backend-sidecar.js` currently uses deprecated `pkg` with a Node 18 target.
- Homebrew distribution is premature until the CLI and standalone artifact story are stable.

## Product Goal

Make Symphony usable from any local project with a short, explainable workflow, while keeping Symphony's own workflow strong and unchanged:

1. Link or install the local Symphony checkout once.
2. Run `symphony doctor` in any project to understand readiness.
3. Run `symphony dashboard` against an existing `WORKFLOW.md`.
4. Run `symphony init` only when a project needs a new workflow.
5. Pick a profile that matches the project, without changing the Symphony-internal profile.
6. Customize only project-specific workflow, hooks, tracker state, and prompt sections.
7. Use project-local `WORKFLOW.md` and optional project-local skills to evolve each workflow over time.

## Non-Goals

- Do not replace `WORKFLOW.md` as the canonical project-owned policy contract.
- Do not make Symphony a general workflow engine.
- Do not require all projects to use Node, TypeScript, Linear, or this repository's internal workflow.
- Do not degrade the current Symphony-internal workflow into the lowest common denominator.
- Do not hide dangerous runtime posture. The high-trust guardrail acknowledgement should become easier to configure deliberately, not disappear silently.
- Do not make packaged defaults mutate user skills or project files without explicit opt-in.
- Do not block local multi-project ergonomics on npm, Homebrew, or public package naming.

## Target User Journeys

### Symphony Internal Use

Use the current repository exactly as it works today:

```bash
symphony dashboard --profile symphony-internal
```

or the compatibility command:

```bash
npm run start:dashboard -- --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Expected behavior:

- The repository `WORKFLOW.md` remains the source of truth for building Symphony itself.
- Internal states such as `Agent Review`, `Merging`, `Rework`, and the existing skill expectations remain intact.
- Internal hooks such as `scripts/worktree_bootstrap.py` and `scripts/workspace-before-remove.js` continue to work relative to this repository.
- Changes made for generic project support do not simplify or weaken the internal workflow.
- Tests include a guard that the internal profile still maps to the checked-in `WORKFLOW.md`.

### Personal Local Use

Install from local checkout while iterating:

```bash
npm run link:local
symphony doctor
symphony dashboard
```

Expected behavior:

- `symphony` resolves to the local checkout, not an npm package.
- `symphony dashboard` defaults to `./WORKFLOW.md`.
- `symphony init` writes a project-local `WORKFLOW.md` or updates one after confirmation.
- Port defaults to `0` unless the workflow pins `server.port`.
- The dashboard prints the resolved URL.
- `.env` is loaded from the project directory.
- `symphony doctor` explains missing tracker credentials, Codex settings, hooks, and workspace provisioning before startup.

### Existing Workflow in Another Project

For a project that already has `WORKFLOW.md`:

```bash
cd /path/to/project
symphony doctor
symphony dashboard
```

Expected behavior:

- No files are generated.
- The workflow path defaults to `$PWD/WORKFLOW.md`.
- The local checkout path is hidden behind the `symphony` command.
- The high-trust acknowledgement can be supplied by CLI or user-global local config, never by the project.

### New Local Project Bootstrap

For a project that needs a workflow:

```bash
cd /path/to/project
symphony init --profile linear-node --dry-run
symphony init --profile linear-node
symphony doctor
symphony dashboard
```

Expected behavior:

- The generated `WORKFLOW.md` is complete and readable.
- The profile gives strong defaults but does not hide the resulting runtime contract.
- Project-specific settings are explicit: tracker, states, workspace provisioner, hooks, prompt body, and skill expectations.
- Existing files are never overwritten without confirmation or `--force`.

### Team Project Use

Install from npm or Homebrew after local usage is proven:

```bash
npm add -D @nielsgalen/symphony
npx symphony init --profile linear-node
npx symphony dashboard
```

For one-off use without a project dependency:

```bash
npx @nielsgalen/symphony init --profile linear-node
```

or:

```bash
brew install nielsgalen/tap/symphony
symphony dashboard
```

Expected behavior:

- The effective workflow is committed to the project.
- Team-specific rules live in `WORKFLOW.md` and optional project skills.
- Secret values remain environment variables.
- `symphony doctor --ci` can run in CI without starting long-running agents.

### External/Open Source Use

Use GitHub Issues without Linear:

```bash
symphony init --tracker github --profile generic
symphony doctor
symphony dashboard --offline
```

Expected behavior:

- GitHub owner/repo are detected from `git remote`.
- Missing `GITHUB_TOKEN` is reported by `doctor` before runtime startup.
- Active/terminal states use GitHub-compatible defaults.
- The prompt avoids Symphony-specific Linear workpad behavior unless selected.

## Proposed CLI Surface

### `symphony dashboard`

Primary long-running command.

Default behavior:

- Load `./WORKFLOW.md`.
- Load `.env` from the current project unless `--env-file` is provided.
- Use `--port 0` by default for project mode to avoid collisions.
- Require explicit high-trust acknowledgement unless a user-global config has opted in.
- Never allow a project-committed config file to suppress the high-trust acknowledgement.

Candidate flags:

```bash
symphony dashboard
symphony dashboard --workflow ./WORKFLOW.md
symphony dashboard --port 61026
symphony dashboard --offline
symphony dashboard --logs-root ./.symphony/logs
symphony dashboard --allow-high-trust-local-run
```

Compatibility:

- Existing `npm run start:dashboard -- ...` should continue to work.
- Existing `npm run start:project-dashboard -- <repo>` can become a thin wrapper around the CLI.
- In the Symphony repo, `symphony dashboard --profile symphony-internal` should be equivalent to the current repository workflow unless the user passes explicit overrides.

### `symphony init`

Project bootstrap command.

Responsibilities:

- Detect git repository root.
- Detect package manager/toolchain where possible.
- Detect GitHub owner/repo from remote.
- Prompt for tracker choice when not provided.
- Generate `WORKFLOW.md` from a built-in profile.
- Optionally generate `.worktreeinclude`, `.env.example`, and `.symphony/config.yaml`.
- Never overwrite existing files without confirmation or `--force`.

Candidate flags:

```bash
symphony init
symphony init --tracker linear --project-slug APP
symphony init --tracker github
symphony init --profile node
symphony init --profile generic
symphony init --workflow-path ./WORKFLOW.md
symphony init --dry-run
```

### `symphony link-local`

Local checkout installer.

Responsibilities:

- Build the TypeScript runtime.
- Create or update a user-local executable shim named `symphony`.
- Point that shim at the current checkout.
- Verify that `symphony --version` and `symphony doctor --help` execute without using npm package installation.
- Print the exact target path and how to remove it.

Candidate forms:

```bash
npm run link:local
symphony link-local --target ~/bin/symphony
```

This command is the local-first answer to "install Symphony once" before npm/Homebrew exists.

### `symphony doctor`

Preflight diagnostics.

Checks:

- `WORKFLOW.md` exists and parses.
- Effective workflow config validates.
- Required env vars resolve.
- Codex command is available.
- Tracker credentials are present.
- Git repository and worktree settings are valid.
- `base_ref` exists or is fetchable.
- Working tree cleanliness matches provisioner policy.
- Hooks are syntactically executable enough to fail early.
- Port/host binding is available if fixed.
- Project-local skill references exist when workflow expects them.

Output modes:

```bash
symphony doctor
symphony doctor --json
symphony doctor --ci
```

### `symphony profile`

Discoverable project profiles.

```bash
symphony profile list
symphony profile show linear-node
symphony profile materialize linear-node --out WORKFLOW.md
```

This can start as a hidden/internal command if `init` owns the user-facing path.

## Configuration and Override Model

Use "override" or "extend" terminology rather than "overload".

### Precedence

Recommended precedence, highest wins:

1. CLI flags for one runtime invocation.
2. Environment variables.
3. Project `WORKFLOW.md`.
4. Project-local `.symphony/config.yaml` for CLI-only preferences.
5. User-global `~/.config/symphony/config.yaml`.
6. Built-in profile defaults.
7. Runtime defaults from resolver.

Important distinction:

- `WORKFLOW.md` remains the runtime contract.
- `.symphony/config.yaml` should configure CLI ergonomics only, such as default port, preferred profile, and init choices.
- Runtime-critical policy should stay in `WORKFLOW.md` so it is versioned with the project.
- High-trust local-run acknowledgement is not a project setting. It must be passed on the CLI or stored in user-global config only.

### Profiles

Profiles should be templates that generate or identify a full `WORKFLOW.md`.

Initial built-ins:

- `symphony-internal`
- `linear-generic`
- `linear-node`
- `github-generic`
- `github-node`
- `memory-demo`

Future built-ins:

- `python`
- `rust`
- `go`
- `macos-app`
- `frontend-web`

Avoid introducing `extends:` in `WORKFLOW.md` for the MVP. Materializing a full file keeps the current loader, validator, hot-reload behavior, and spec contract intact. A later BRD/PRD can add workflow inheritance if the generated files become too repetitive.

The `symphony-internal` profile is special:

- It is not a generic default.
- It maps to the repository's checked-in `WORKFLOW.md`.
- It preserves the current state machine, skill expectations, hooks, and high-trust local posture.
- It should have regression tests that fail if local-first project support changes internal Symphony behavior.
- It can be copied as inspiration, but `init` should not use it for arbitrary projects unless explicitly requested.

Generic profiles are intentionally smaller:

- They should describe issue execution, commit/PR expectations, and validation clearly.
- They should avoid Symphony-specific states unless the user chooses an advanced Linear profile.
- They should make project-specific hook commands visible instead of hiding them in runtime magic.

### Project Overrides

Project teams should customize:

- Tracker states.
- Project slug, owner, repo.
- Workspace provisioner.
- Hook commands.
- Prompt body.
- Codex model/reasoning/security posture.
- Validation expectations and handoff flow.

Do not customize:

- Runtime internals.
- Built-in profile files in the installed package.
- Generated files outside the project unless explicitly requested.

### Profile Boundaries

There are three separate surfaces:

1. Runtime contract: `WORKFLOW.md`.
2. CLI ergonomics: user-global config and optional project-local `.symphony/config.yaml`.
3. Profile templates: source material used by `init` or `profile materialize`.

Runtime must only consume the effective `WORKFLOW.md` plus existing env/CLI overrides. It should not re-read profile templates during execution. This keeps debugging honest: when a run behaves strangely, the operator inspects the workflow file that was actually used.

### User-Local Overrides

Use user-local config for preferences that should not be committed:

- Default port behavior.
- Default Codex home.
- Preferred model/reasoning.
- Whether high-trust local startup acknowledgement has been accepted for this machine.
- Default logs root.
- Preferred tracker credential env var names.

High-trust acknowledgement should include a visible diagnostic record:

- source: `cli` or `user_config`;
- user config path when applicable;
- runtime version or minimum accepted version;
- effective workflow path;
- security profile, approval policy, and sandbox policy.

## Skills and Prompt Customization

### Current Problem

The internal `WORKFLOW.md` names skills such as `linear`, `commit`, `push`, `pull`, and `land`. Those are appropriate for Symphony's own workflow but too specific for arbitrary projects.

### Target Model

Separate workflow content into three layers:

1. Built-in generic prompt sections.
2. Optional skill packs.
3. Project-local instructions.

The generated `WORKFLOW.md` should be explicit about which skills it expects. If a project wants a different commit workflow, it should replace that prompt section or point to a project-local skill.

### Skill Pack Candidates

Packaged reusable skill/prompt modules:

- `commit-generic`: small atomic commits, no Symphony-specific issue tracker assumptions.
- `github-pr-generic`: push branch and open/update PR.
- `linear-workpad`: Linear workpad discipline for teams that want it.
- `ui-evidence`: Playwright screenshot/video evidence publishing, tracker-specific implementations optional.
- `land-generic`: merge monitoring loop, initially GitHub-only.
- `project-doctor`: guidance for diagnosing project setup.

### Skill Resolution Policy

Document and validate a predictable order:

1. Project-local `.codex/skills`.
2. User-local `$CODEX_HOME/skills`.
3. Symphony-packaged skill packs.
4. Codex/plugin-installed skills.

This policy needs verification against Codex's actual skill resolution behavior before it becomes a runtime promise. Until then, phrase it as a packaging goal and make `doctor` report what it can observe.

## Installation and Distribution Options

### Option A: Local Checkout Wrapper

Command:

```bash
npm --prefix /path/to/symphony run start:project-dashboard -- "$PWD"
```

Pros:

- Already works.
- Best for development.
- No packaging changes required.

Cons:

- Not memorable.
- Requires a local checkout.
- Hard to share with other projects/users.

Recommendation:

- Keep as compatibility/development path.
- Add docs that point users to the local linked CLI once available.

### Option A2: Local Linked Checkout

Command:

```bash
cd /path/to/symphony
npm run link:local
cd /path/to/project
symphony doctor
symphony dashboard
```

Pros:

- Fastest path to using Symphony across local projects.
- Keeps development velocity high while the CLI and profile model stabilize.
- Avoids public package naming, npm publishing, Homebrew, and standalone binary work.
- Lets the same checkout continue building Symphony itself.

Cons:

- Still depends on the local source checkout.
- Not suitable for external users without cloning the repo.
- Needs clear unlink/update behavior.

Recommendation:

- Make this the first implementation target.
- Treat public distribution as a later proof that the local model is stable.

### Option B: npm Package

Command:

```bash
npm add -D @nielsgalen/symphony
npx symphony dashboard
```

or:

```bash
npm install -g @nielsgalen/symphony
symphony dashboard
```

Pros:

- Natural for current Node/TypeScript implementation.
- Fastest path to a real `symphony` command.
- Works with existing build output.
- Good for project-local version pinning.
- Uses npm's documented `bin` mechanism to install command-line executables.

Cons:

- Requires Node/npm on the user machine.
- Packaging must include built assets, profiles, and scripts.
- Native desktop sidecar is a separate concern.
- Requires scoped package naming because `symphony` is already occupied on npm.
- Requires an explicit package allowlist because npm currently falls back to `.gitignore`, which excludes `dist/`.

Recommendation:

- Make npm the first public distribution target after local multi-project use is proven.
- Publish under a scoped package name, with a `bin` named `symphony`.
- Add `bin`, `files`, build/package verification, and `npm pack` smoke tests before publishing.
- Do not rely on `npm run build` at command startup for installed packages; the package must ship built runtime files.

### Option C: Standalone Node Binary

Use a maintained executable packaging route, evaluated after npm distribution works. Node's built-in Single Executable Application support is a candidate, but it is still marked active development and needs a proof spike for assets, CommonJS/ESM shape, native modules, signing, and cross-architecture builds.

Pros:

- Better for Homebrew.
- Avoids requiring Node at runtime.
- Easier to install outside JS projects.

Cons:

- Needs careful asset inclusion for dashboard, profiles, scripts, and skill packs.
- Native dependencies and dynamic imports can become brittle.
- Must validate on macOS first, then Linux if desired.
- The current `pkg` dependency is deprecated and should not be the strategic default.
- Current sidecar packaging targets Node 18, which is end-of-life.

Recommendation:

- Do after npm CLI stabilizes.
- Treat the current `pkg` sidecar as legacy technical debt.
- Run a dedicated packaging spike comparing Node SEA, a maintained `pkg` fork, and other maintained packagers.
- Use a supported Node LTS line for any embedded runtime.
- Use the selected standalone artifact behind Homebrew.

### Option D: Homebrew Formula

Command:

```bash
brew install nielsgalen/tap/symphony
symphony dashboard
```

Pros:

- Very convenient for personal and Mac-first use.
- Good fit for a long-running local tool.

Cons:

- Needs versioned release artifacts.
- Requires update/release discipline.
- Should not be the first packaging surface until the executable contract is stable.
- Formula must include a real `test do` block that exercises `symphony --help`, `symphony profile list`, and a temp-project `doctor`/`init --dry-run` path.

Recommendation:

- Target after standalone binary packaging and release checks pass.

### Option E: Desktop App

Command:

```bash
open Symphony.app
```

Pros:

- Lowest-friction monitoring surface.
- Sidecar packaging work already exists.

Cons:

- Project initialization, workflow editing, and terminal-based auth still need CLI support.
- Desktop app alone does not solve project bootstrap.

Recommendation:

- Treat desktop as the operator surface, with CLI remaining the setup and automation entrypoint.

## Recommended Roadmap

### Phase 0: Local-First Planning Baseline

Deliverables:

- This planning document.
- Decision on local executable/link strategy.
- Agreement that `WORKFLOW.md` remains the canonical generated artifact.
- Agreement that `symphony-internal` remains a preserved golden profile.

Exit criteria:

- BRD can be written from this plan.
- Issues can be generated from the work item list below.

### Phase 1: Local Command MVP

Deliverables:

- `package.json` `bin` entry for `symphony`.
- Local link/install command, for example `npm run link:local`.
- CLI command router with `dashboard`, `init`, `doctor`, and `profile list`.
- `dashboard` wraps existing runtime startup.
- Existing npm scripts continue to work.
- `start-project-dashboard.sh` delegates to CLI or remains tested as compatibility.
- `symphony-internal` profile maps to the checked-in workflow.

Acceptance criteria:

- From the Symphony checkout, `npm run link:local` creates a working local `symphony` command.
- From another repo, `symphony dashboard --workflow ./WORKFLOW.md --port 0` starts the dashboard.
- `symphony dashboard` defaults to `./WORKFLOW.md`.
- From the Symphony repo, `symphony dashboard --profile symphony-internal` preserves current behavior.
- Guardrail acknowledgement is handled by an explicit CLI flag or user-global config with clear diagnostics.
- Project-local config cannot suppress high-trust acknowledgement.
- Local linked CLI can depend on the source checkout, but it must not require the user to remember `npm --prefix`.
- `npm run build`, `npm test`, and `git diff --check` pass.

### Phase 2: Project Profile Bootstrap

Deliverables:

- Built-in profile registry.
- `symphony init` dry-run and materialize modes.
- Generated `WORKFLOW.md` for Linear/GitHub generic and Node profiles.
- `.env.example` and `.worktreeinclude` optional generation.
- Git remote detection for GitHub defaults.
- Clear distinction between `symphony-internal` and generic project profiles.

Acceptance criteria:

- Running `symphony init --tracker github --profile node --dry-run` shows a complete proposed file set.
- Running `symphony init --tracker linear --project-slug APP` creates a valid workflow.
- Existing `WORKFLOW.md` is not overwritten without explicit confirmation/force.
- Generated generic workflows do not include Symphony-internal lifecycle states unless requested.

### Phase 3: Doctor and Diagnostics

Deliverables:

- `symphony doctor` command.
- JSON output for CI and UI integration.
- Checks for workflow validation, env vars, Codex command, git/worktree readiness, hooks, tracker auth presence, and port binding.

Acceptance criteria:

- `doctor --ci` exits non-zero on missing required env vars or invalid workflow.
- `doctor --json` output is stable enough for tests and future desktop UI.
- Diagnostics map to existing workflow validator error codes where possible.
- For this repo, `doctor` reports that `symphony-internal` is active or available.

### Phase 4: Skill and Prompt Packs

Deliverables:

- Generic prompt modules or packaged skills for common flows.
- Profiles that opt into skill packs explicitly.
- `doctor` reports missing expected project/user skills.
- Documentation explains how to override generated prompt sections.

Acceptance criteria:

- A non-Symphony project can use a generic Linear or GitHub workflow without references to Symphony's internal states unless selected.
- Project-local skill overrides are documented and detected.
- Generated workflows list required skills/tools in a clear section.

### Phase 5: Local Multi-Project Trial

Deliverables:

- Use the local linked command against at least two non-Symphony projects.
- Capture friction in startup, profile generation, hooks, credentials, and skill expectations.
- Refine profiles based on real use.
- Keep a compatibility check that Symphony's own workflow still behaves the same.

Acceptance criteria:

- Existing workflow project: `symphony doctor` then `symphony dashboard` works without generating files.
- New workflow project: `symphony init --profile ...`, `doctor`, and `dashboard` works.
- At least one Node project and one non-Node or generic project path are exercised, even if the non-Node profile is minimal.
- Lessons are folded back into the BRD before package distribution work starts.

### Phase 6: npm Distribution

Deliverables:

- Scoped package name decision, for example `@nielsgalen/symphony`.
- Package manifest includes built JS, dashboard assets, profiles, and required scripts.
- Package manifest excludes tests, source-only implementation files, source PRDs, internal development-only workflows, and generated local artifacts unless intentionally shipped.
- Package allowlist is implemented through `package.json` `files` or a root `.npmignore`, with tests proving `dist/` and required assets are included.
- Release checklist.
- `npm pack` integration test installs into a temp project and runs `symphony --help`, `symphony profile list`, `symphony init --dry-run`, and `symphony doctor --ci`.

Acceptance criteria:

- Package works outside the source checkout.
- No absolute local paths are required.
- Package size and included files are intentional.
- `npm pack --dry-run --json` is asserted in CI.
- The published package name is scoped or otherwise confirmed available immediately before publish.

### Phase 7: Standalone Binary and Homebrew

Deliverables:

- macOS standalone binary artifact.
- Asset inclusion tests for profiles/dashboard/scripts.
- Homebrew formula or tap.
- Release automation.
- Replacement plan for deprecated `pkg` sidecar packaging, including supported Node LTS target.

Acceptance criteria:

- `brew install ...` provides `symphony`.
- `symphony dashboard` works in a temp project without a Symphony source checkout.
- Version reporting and upgrade behavior are documented.
- `brew test` exercises a meaningful CLI path in a temporary directory.

### Phase 8: Desktop-CLI Integration

Deliverables:

- Desktop can select/open a project workflow.
- Desktop can run or display `doctor` diagnostics.
- Desktop uses the same packaged backend and profile registry.

Acceptance criteria:

- A user can initialize from CLI and monitor from desktop without path surgery.
- Desktop errors point to actionable CLI/doctor remediation.

## BRD Seed

### Business Objective

Increase Symphony's usefulness beyond its own repository by making the local checkout project-portable and customizable first, while preserving the versioned workflow contract that makes runs auditable. Public distribution is a later scaling step, not the first proof point.

### Users

- Primary: the current maintainer using Symphony across multiple local projects.
- Secondary: engineering teams that want issue-driven coding-agent orchestration in their own repos.
- Tertiary: external users experimenting with GitHub or Linear workflows.

### Value Proposition

- One install, many projects.
- Project-owned workflows with strong defaults.
- Faster onboarding through generated profiles.
- Safer operation through preflight diagnostics.
- Customizable skills and prompt sections without forking Symphony.
- No regression to the current Symphony-internal workflow.

### Success Metrics

- Time from clean project to running dashboard under 10 minutes.
- Time from an existing project `WORKFLOW.md` to running dashboard under 2 minutes after local link.
- Zero need to remember `npm --prefix /path/to/symphony ...` after local link.
- Zero required references to the Symphony source checkout for npm/Homebrew installs once those distribution paths exist.
- `doctor --ci` catches missing auth/config before long-running startup.
- At least one non-Symphony project runs through a full issue lifecycle with generated defaults.
- Profiles require fewer than five manual edits for common Linear/GitHub Node projects.
- `npm pack --dry-run --json` and temp-install smoke tests prove package contents before publish.

### Constraints

- Preserve `SPEC.md`'s repo-owned `WORKFLOW.md` model.
- Preserve the checked-in Symphony `WORKFLOW.md` as the internal golden workflow.
- Keep top-level implementation structure under `src/`, `tests/`, and `scripts/` unless governance approves a change.
- Keep high-trust runtime posture explicit.
- Do not allow project files to silently opt out of high-trust acknowledgement.
- Do not bake personal machine paths into distributable artifacts.
- Avoid committing secrets or generating secret-bearing files.
- Do not base future standalone distribution on deprecated `pkg` without an explicit accepted exception.

## Issue Candidate Backlog

| ID | Title | Scope | Acceptance |
|---|---|---|---|
| LOCAL-00 | Add local `symphony` command | Add package `bin` and local link/install script for this checkout. | `npm run link:local` makes `symphony --help` work without `npm --prefix`. |
| LOCAL-01 | Preserve `symphony-internal` profile | Model current repository workflow as a golden internal profile. | Tests prove `symphony-internal` maps to checked-in `WORKFLOW.md` and preserves internal states/skill expectations. |
| LOCAL-02 | Implement `symphony dashboard` project defaults | Default workflow to `./WORKFLOW.md`, project `.env`, port handling, guardrail flag/config. | Starts against another repo without `npm --prefix`; prints URL and workflow path. |
| LOCAL-03 | Create profile registry | Move example workflows into loadable local profiles with metadata. | `symphony profile list/show` returns `symphony-internal`, Linear/GitHub generic, and Node profiles. |
| LOCAL-04 | Implement `symphony init --dry-run` | Detect git root/toolchain/tracker inputs and render proposed files. | Dry-run prints complete `WORKFLOW.md` without writing. |
| LOCAL-05 | Implement safe `symphony init` writes | Materialize `WORKFLOW.md`, optional `.env.example`, `.worktreeinclude`, with overwrite protection. | Existing files are preserved unless `--force`; generated workflow validates. |
| LOCAL-06 | Add `symphony doctor` workflow/env checks | Validate workflow parse/config/env/Codex command/git readiness. | Missing env vars and invalid config produce actionable errors and non-zero CI exit. |
| LOCAL-07 | Add `doctor --json` contract | Stable JSON diagnostics for CI/desktop. | Tests assert schema for pass/fail cases. |
| LOCAL-08 | Package generic prompt/skill packs for local profiles | Provide reusable prompt sections for commit, PR, Linear workpad, GitHub flow. | Generated non-Symphony workflow contains no internal Symphony-only lifecycle unless selected. |
| LOCAL-09 | Run local multi-project trial | Exercise linked checkout against existing and newly initialized non-Symphony projects. | Findings are recorded and profile defaults updated before npm/Homebrew work starts. |
| DIST-00 | Decide package identity | Choose scoped npm package name and Homebrew tap/formula naming. | `npm view <chosen-package>` confirms availability/ownership; binary remains `symphony`. |
| DIST-09 | Validate package contents with `npm pack` | Ensure built JS, dashboard assets, profiles, scripts, and approved skills ship while source/tests/dev-only docs are excluded. | Temp install smoke test runs CLI commands outside source checkout; `npm pack --dry-run --json` is asserted. |
| DIST-10 | Remove absolute path assumptions from packaged profiles | Audit generated docs/profiles/scripts for local machine paths. | Package tests fail on `/Users/.../code/symphony` references in distributable assets. |
| DIST-11 | Standalone binary packaging spike | Compare Node SEA and maintained packagers; retire or explicitly quarantine deprecated `pkg` usage. | Chosen path runs `--help`, `profile list`, `init --dry-run`, and `doctor --ci` in temp project on a supported Node LTS baseline. |
| DIST-12 | Homebrew formula | Publish formula/tap for standalone binary. | `brew install` provides working `symphony` command. |
| DIST-13 | Desktop project selection | Allow desktop app to open/select project workflow. | Desktop starts backend for selected project and surfaces boot errors. |
| DIST-14 | Documentation refresh | Update README, tutorial, integrate playbook, and workflow examples around new CLI. | New user path starts with install/init/doctor/dashboard. |
| DIST-15 | Guardrail acknowledgement hardening | Ensure project files cannot suppress high-trust acknowledgement. | Tests prove only CLI flag or user-global config can acknowledge; diagnostics expose effective source. |

## Key Design Decisions Needed

1. Local command strategy: `npm link`, custom shim, or both.
2. Exact shape of `symphony-internal` profile and its regression tests.
3. Name of the high-trust acknowledgement flag/config.
4. Whether `symphony init` should create `.symphony/config.yaml` in MVP.
5. Whether profiles should be pure generated workflows in MVP or introduce workflow inheritance.
6. Whether local skill packs should be copied into projects or referenced from the Symphony checkout.
7. How strongly to support non-Node projects before distribution is complete.
8. First public install target later: npm global, npm devDependency, or both.
9. Final scoped npm package name later.
10. Whether Homebrew should wrap a standalone binary or install the npm package.
11. Which maintained standalone packaging route replaces the current deprecated `pkg` sidecar.

Recommended defaults:

- Build a local linked `symphony` command before public package work.
- Treat `symphony-internal` as a protected profile.
- Support both `npm install -g @nielsgalen/symphony` and `npm add -D @nielsgalen/symphony` later, once package-ready.
- Keep generated full `WORKFLOW.md` for MVP.
- Defer inheritance until repeated generated sections become painful.
- Use `doctor` as the enforcement surface for skill availability rather than runtime magic.
- Make Homebrew install a standalone binary, not an npm shim.
- Do not let project-local config acknowledge high-trust execution.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Plan optimizes for public distribution before local use is proven | Slow feedback and unnecessary naming/package work. | Make local linked checkout the first milestone; push npm/Homebrew to later phases. |
| Generic profiles weaken the current Symphony workflow | The workflow that already works for building Symphony regresses. | Protect `symphony-internal` as a golden profile with regression tests. |
| Profile abstraction hides runtime behavior | Operators cannot debug which rules actually ran. | Runtime consumes materialized `WORKFLOW.md`; profiles are generation-time only for MVP. |
| Unscoped `symphony` npm name is occupied | Users install the wrong package. | Publish scoped package and reserve binary name through `bin`; add prepublish name check. |
| npm package contents are accidental | Installed package is unusable or leaks internal files. | Add package allowlist plus `npm pack --dry-run --json` assertions and temp-install smoke tests. |
| Packaged CLI accidentally depends on source checkout paths | External installs fail. | `npm pack` temp install tests and path-audit test. |
| Deprecated `pkg` remains the binary strategy | Binary distribution inherits an unsupported toolchain and EOL Node target. | Treat `pkg` as legacy; run Node SEA/maintained-packager spike before Homebrew. |
| Presets become another hidden config layer | Users cannot reason about runtime behavior. | Materialize complete `WORKFLOW.md`; make generated comments clear. |
| Skill resolution differs from desired packaging model | Generated workflows reference unavailable skills. | Start with explicit prompt text; use `doctor` to detect optional skills. |
| Project config hides guardrail acknowledgement | Cloned repo can silently normalize unsafe startup. | Only CLI/user-global config can acknowledge; project config is ignored for this setting. |
| Guardrail acknowledgement becomes too easy to miss | Unsafe local runs become normalized. | Require explicit opt-in with clear naming and `doctor` visibility. |
| Homebrew release happens before binary assets are reliable | Install failures and support burden. | Ship npm first; gate Homebrew on standalone smoke tests. |
| Language-specific profiles sprawl | Maintenance cost grows. | Start with generic and Node; add more only after init/doctor contracts stabilize. |

## Completion Definition for the Distribution Program

This program should be considered complete when:

- A fresh non-Symphony repository can be initialized with `symphony init`.
- `symphony doctor` catches missing local prerequisites before runtime startup.
- `symphony dashboard` runs without referencing the Symphony source checkout.
- A local linked checkout can operate multiple projects without remembering `npm --prefix`.
- Symphony's checked-in workflow remains the protected internal profile.
- Built-in profiles cover Linear/GitHub and generic/Node workflows.
- Project-local workflow customization is documented and version-controlled.
- Skill/prompt customization has an explicit override story.
- npm distribution works outside the checkout.
- Homebrew distribution works from a versioned standalone artifact, if chosen.

## Verification Evidence

Audit evidence captured on 2026-05-11:

- Local package manifest: no `bin`, no `files`, package name currently `symphony`.
- Current Symphony workflow: checked-in `WORKFLOW.md` includes the rich internal Linear lifecycle, handoff states, hooks, skill expectations, and high-trust Codex posture that should remain preserved.
- npm registry: unscoped `symphony` exists as unrelated package version `0.0.8`.
- npm registry: `@nielsgalen/symphony` returned `E404` at audit time, but availability must be rechecked immediately before publish.
- `npm pack --dry-run --json`: package currently includes source/tests/docs/internal skills and omits compiled `dist/`.
- Local sidecar builder: `scripts/build-desktop-backend-sidecar.js` invokes `npx pkg` and targets `node18-*`.
- Upstream `vercel/pkg`: deprecated with `5.8.1` as the last release.
- Node release schedule: Node 18 reached end-of-life on 2025-04-30.
- Node SEA docs: Single Executable Applications exist but are marked active development.
- npm package docs: `bin` installs command executables; `files` controls package contents, with some files always included/excluded.
- Homebrew docs: formulae should include a meaningful `test do` block run by `brew test`.

Primary sources used for non-local facts:

- npm package metadata docs: <https://docs.npmjs.com/cli/v11/configuring-npm/package-json/>
- Node SEA docs: <https://nodejs.org/api/single-executable-applications.html>
- Node release schedule: <https://github.com/nodejs/Release>
- Homebrew formula cookbook: <https://docs.brew.sh/Formula-Cookbook>
- `vercel/pkg` repository: <https://github.com/vercel/pkg>

## Confidence Model

This strategy should not claim literal permanent 100% certainty. Distribution strategy depends on external registries, package-manager behavior, Codex skill resolution behavior, and future runtime support windows. Instead, the actionable standard is:

- 100% confidence in local facts that were directly inspected and are recorded in the verification evidence.
- High confidence in the revised sequence because each external-risky step is now gated by a concrete proof command before the next distribution surface.
- No confidence claim for future package-name availability, Homebrew policy, or standalone packager viability until those checks run at implementation/release time.

The revised strategy is acceptable to turn into a BRD only if the BRD preserves these hard gates:

1. Local linked checkout works before npm/Homebrew work starts.
2. `symphony-internal` is protected by regression tests.
3. Project files cannot acknowledge high-trust execution.
4. Scoped npm package identity is verified immediately before publish.
5. `npm pack --dry-run --json` is asserted before every package release.
6. Temp-install smoke tests run outside the source checkout.
7. Deprecated `pkg` is not the future binary strategy without an explicit exception.
8. Homebrew waits for a tested standalone artifact.
