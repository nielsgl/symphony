# Local Command Runbook

`SPEC.md` remains the canonical Symphony service specification. Do not edit it
for local-command adoption notes or project-specific Symphony extensions. Put
local-command additions in `SPEC.ext.md` or operational docs like this runbook.

## Link The Checkout

From the Symphony checkout:

```bash
npm run link:local
```

The linker builds the checkout, writes a Symphony-owned shim to
`~/.local/bin/symphony`, and verifies `symphony --version`. If
`~/.local/bin` is not on `PATH`, the linker prints shell-specific guidance.
For zsh, the expected shape is:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Use a custom target only when needed:

```bash
npm run link:local -- --target ~/bin/symphony
```

Update by rerunning `npm run link:local` from the checkout. Unlink by removing
the shim path printed by the command, usually:

```bash
rm "$HOME/.local/bin/symphony"
```

Inspect the shim with the command printed by the linker. A valid linked shim is
marked as Symphony-owned and records the checkout root it delegates to.

## Adopt A Project

From a project that contains `WORKFLOW.md`:

```bash
symphony --version
symphony --help
symphony setup --yes
symphony doctor
symphony dashboard
```

`symphony dashboard` defaults to the current project's nearest `WORKFLOW.md`,
loads that project's `.env` when present, binds `127.0.0.1`, and uses port `0`
unless `--port` or `SYMPHONY_PORT` is provided.

Use explicit overrides when operating outside the project root:

```bash
symphony dashboard --workflow ./WORKFLOW.md --port 0
symphony dashboard --workflow /path/to/project/WORKFLOW.md --port 3001
```

For the Symphony checkout itself, use the protected internal profile:

```bash
symphony dashboard --profile symphony-internal
```

This profile binds to the checked-in Symphony `WORKFLOW.md`. It is not a
generated project profile and does not materialize files.

## Project Layout Boundary

The root `WORKFLOW.md` is the committed project contract for local Symphony
execution. `SPEC.md` remains the canonical service specification; do not edit it
for local layout extensions. Put layout usage additions in `SPEC.ext.md` or
operational docs.

Runtime-owned local state belongs under `.symphony/system/`:

- `.symphony/system/workspaces/` for per-issue workspaces.
- `.symphony/system/logs/` for local runtime logs.
- `.symphony/system/runtime.sqlite` for local persistence.

The project root `.gitignore` should ignore `.symphony/system/`. Do not use a
broad `.symphony/`, `.symphony/*`, or `.symphony/**` rule for normal operation,
because that hides project-owned Symphony customization from review.

`.symphony/skills/` and `.symphony/prompts/` are reserved project-owned
customization paths. They are intentionally visible to git today and are not
loaded by the runtime until a future customization implementation deliberately
adds that behavior.

Project-local portable skills are copied to `.codex/skills/`, not
`.symphony/skills/`, because `.codex/skills/` is the Codex project-local skill
location. The copied files are intentionally owned by the target project after
init. Operators may edit the local `SKILL.md` files or helper scripts, and
Symphony will not secretly update or override those edits at runtime.

During migration, a repository may still contain old runtime state such as
`.symphony/workspaces/`, `.symphony/log/`, `.symphony/logs/`,
`.symphony/runtime.sqlite`, `.symphony/runtime.sqlite-*`, or
`.symphony/state.db`. `setup` and `doctor --fix --yes` may add the missing
`.symphony/system/` ignore entry, but they do not automatically move or delete
legacy runtime state and they do not remove broad ignore rules. Migrate those
paths manually after confirming no active Symphony process still uses them.

## Setup Consent

`symphony setup --yes` records explicit user-local consent for the resolved
project/workflow identity. Consent is stored under user-local state, keyed to
the exact project root, workflow path, workflow hash, and required posture.

Project files may declare why high-trust execution is needed, but they cannot
grant consent. A cloned repository cannot make dashboard startup trusted by
checking in state. If the project path or workflow identity changes, rerun
setup for the new identity.

## Doctor

Run doctor before dashboard startup:

```bash
symphony doctor
symphony doctor --json
symphony doctor --ci
```

Doctor checks the linked shim, checkout target, built CLI entrypoint, workflow
resolution, effective workflow config, `.env` path, host/port readiness, setup
consent, and dashboard supervisor prerequisites. It reports paths and status;
it does not print `.env` values or consent-store contents.

For generated workflows, doctor also reports generated profile and portable
skill provenance as observable project content. It treats `.codex/skills/` as
the materialization root and `.symphony/skills/` as reserved, not as an active
runtime source.

Exit codes:

- `0`: clean.
- `1`: warning-only findings.
- `2`: blocker findings.

Use bounded remediation only when intentional:

```bash
symphony doctor --fix --yes
```

The fix path can refresh the local link and record setup consent. It does not
silently rewrite project runtime policy or implement later diagnostic PRDs.

## Bounded Surfaces

These commands are intentionally bounded in the local command surface:

```bash
symphony profile list
symphony profile show <pack-or-bundle>
symphony init --help
symphony init
symphony init --dry-run --bundle memory-generic
symphony init --bundle memory-generic
symphony init --dry-run --bundle memory-generic --skill commit --skill land
symphony init --dry-run --bundle memory-generic --skills commit,land
symphony init --dry-run --bundle memory-generic --no-skills
symphony init --bundle memory-generic --force-skills
symphony init --no-input --bundle linear-node --linear-project-slug SYMPHONY
symphony init --no-input --bundle github-node --github-owner octo-org --github-repo octo-repo
```

`profile list` exposes the composable profile registry: tracker, workspace,
toolchain, and workflow packs plus named bundles such as Linear/Node and
GitHub/Node. `profile show <pack-or-bundle>` prints registry metadata, intended
use, bundle expansion, conflict or required-dimension validation output, and
protected binding behavior. `symphony-internal` remains a protected binding to
the checked-in `WORKFLOW.md`, not a generated template. `init` supports
non-destructive generated workflow materialization from profile packs and
bundles. In an interactive terminal, `symphony init` prompts for missing
tracker, workspace, toolchain, workflow-style, and hosted tracker inputs. Use
`--dry-run` to inspect the file plan before writing; existing generated targets
require confirmation or `--force`.

Init selects the portable `commit`, `pull`, `push`, and `land` skills by
default. `linear-graphql` and `linear-ui-evidence` are opt-in. Use repeated
`--skill <name>` flags or comma-separated `--skills <name,name>` to select an
explicit set. Use `--no-skills` to materialize no skills; it cannot be combined
with `--skill` or `--skills`.

The first portable skill pack has these prerequisites:

- `commit`: Codex project-local skill loading and `git`.
- `pull`: Codex project-local skill loading and `git`.
- `push`: Codex project-local skill loading, `git`, and authenticated GitHub
  CLI.
- `land`: Codex project-local skill loading, `git`, authenticated GitHub CLI,
  `uv`, and Python.
- `linear-graphql`: Codex project-local skill loading and a configured Linear
  GraphQL client.
- `linear-ui-evidence`: Codex project-local skill loading, Node.js, and Linear
  MCP or equivalent Linear upload access.

Write mode is non-destructive by default. If a generated target already exists,
init stops unless the operator confirms interactively or passes `--force`.
`--force-skills` is narrower: it overwrites only `.codex/skills/` files and
does not overwrite unrelated init outputs such as `WORKFLOW.md`. Extra user
files under a copied skill directory are preserved. Directory conflicts and
skill destinations that resolve outside the target project or `.codex/skills/`
tree are refused.

Automation should use `--no-input` or `CI=true` with explicit selections. Hosted
tracker workflows also require runtime-critical hosted inputs: Linear needs
`--linear-project-slug`, and GitHub needs a detectable GitHub remote or explicit
`--github-owner` plus `--github-repo`. Non-interactive runs fail with actionable
errors instead of materializing placeholder owner, repo, or project slug values.

## Compatibility Entrypoints

The existing npm workflows remain supported during adoption:

```bash
npm run start:dashboard -- --port=0 --i-understand-that-this-will-be-running-without-the-usual-guardrails
npm run start:project-dashboard -- /path/to/project --port 0
```

`start:project-dashboard` remains the old-script compatibility wrapper for
multi-project use. It resolves `<project>/WORKFLOW.md`, defaults to port `0`,
and delegates through the existing dashboard startup path.

## Smoke Verification

Run the cross-project adoption smoke after build output is available:

```bash
npm run smoke:local-command
```

The smoke creates temporary external projects with `WORKFLOW.md`, links a
temporary `symphony` shim, runs the bounded command surfaces, verifies setup and
doctor behavior, starts dashboard through explicit/default/profile paths using
a deterministic supervisor child, and exercises the compatibility wrapper.

The same smoke also exercises the project layout matrix:

- no `.gitignore`;
- broad `.symphony/` ignore;
- narrow `.symphony/system/` ignore;
- legacy runtime state present;
- Symphony self-hosting through `symphony-internal`;
- Node-ish project with `package.json`;
- generic project without Node metadata.

It validates that effective workspace, log, and persistence paths default under
`.symphony/system/`; `.symphony/system/` is ignored while
`.symphony/skills/` and `.symphony/prompts/` stay visible in healthy layouts;
doctor/setup guidance is present for missing, broad-ignore, and legacy cases;
and legacy runtime state is neither moved nor deleted automatically.

## Local Multi-Project Trial Evidence

Run the reusable Local Multi-Project Trial harness after build output exists:

```bash
npm run build
npm run trial:local-multi-project
```

The harness uses the linked `symphony` executable when it is available on
`PATH`; otherwise it uses `node scripts/symphony.js` as the local-development
fallback. It writes a JSON evidence report under
`output/local-multi-project-trial/` by default and prints the exact report path.

The dry baseline does not require hosted tracker credentials. It creates
synthetic temporary projects, exercises the protected `symphony-internal`
profile against the checked-in Symphony `WORKFLOW.md`, and records command
availability, profile discovery/show output, `setup --yes`,
`doctor --json`, dashboard bind proof, `/api/v1/state`,
`/api/v1/diagnostics`, Project Identity root/workflow matching, and clean
dashboard shutdown.

The default run includes a generated generic/non-Node adoption lane. That lane
starts from a fresh git project without Node package metadata, runs
`symphony init --dry-run --bundle memory-generic --no-input`, verifies that the
dry-run file plan writes no files, runs the non-destructive init write path,
reruns init to prove unchanged generated files are skipped, and then runs
`symphony setup --yes`, `symphony doctor --json --ci`, and the dashboard probe
from the generated project. The report captures generated file summaries,
workflow provenance and validation behavior, doctor findings, reserved
customization path visibility, runtime state layout, ambient `SYMPHONY_*`
handling, and dashboard identity/shutdown evidence.

The default run also includes a generated Linear/Node setup lane. That lane
starts from a fresh Node git project with minimal package metadata and a real
`npm test` command, runs `symphony init --dry-run` and `symphony init` with an
explicit disposable project slug, verifies that the write plan matches the
dry-run plan, commits intended init files, and then runs `symphony setup --yes`,
`symphony doctor --json --ci`, and the dashboard probe from that generated
project root. In the dry baseline, missing Linear credentials are recorded as
expected hosted issue-run prerequisites for that lane rather than as default
trial blockers; unexpected doctor blockers still block the lane.

Synthetic lanes are labeled with `"synthetic": true` and
`"counts_for_external_project_evidence": false`. They prove harness behavior and
non-hosted command readiness, but they do not satisfy the existing
external-project evidence required by the Local Multi-Project Trial parent PRD.
When no real existing project root is supplied, the report includes a blocked
`real-existing-project-missing` lane instead of counting synthetic evidence as a
pass.

Include real local projects only through command arguments, not checked-in paths:

```bash
npm run trial:local-multi-project -- \
  --project-shape existing-node \
  --project-root /path/to/existing/project \
  --project-shape existing-generic \
  --required-project-root /path/to/required/project
```

Use `--project-root` for optional evidence lanes and `--required-project-root`
when the lane must be present for a closure run. A missing required root is
reported as an environment prerequisite with remediation instructions, not as a
passed lane.

Every real-project lane runs `symphony doctor --json` and promotes the
parsed doctor status into `lane.doctor`. Doctor blockers keep the lane from
passing even when dashboard startup later succeeds; the report includes the
doctor reason, exit semantics, summarized findings, and remediation guidance.
Warning-only doctor results become `passed_with_warnings` so closure evidence
can distinguish clean adoption from usable-but-frictional adoption.

Automated regression tests may provide synthetic existing-workflow fixtures with
`--synthetic-project-root /path/to/fixture`. Those lanes use the same command
surface, but remain explicitly synthetic and never count as full real-project
evidence.

Hosted tracker credentials are never printed. The report summarizes
`SYMPHONY_*`, Linear, and GitHub credential variables as present or missing, and
secret-like values are redacted from command transcript summaries. To make
hosted credentials part of operator intent, pass explicit disposable Linear and
GitHub resources:

```bash
npm run trial:local-multi-project -- \
  --with-hosted-credentials \
  --hosted-linear-project-slug SYMPHONY-TRIAL \
  --hosted-linear-project-disposable \
  --hosted-linear-issue-id TRI-123 \
  --hosted-github-owner octo-org \
  --hosted-github-repo symphony-trial-node \
  --hosted-github-remote-url git@github.com:octo-org/symphony-trial-node.git
```

The hosted lane fails closed as `environment_prerequisite` when intent,
credentials, disposable resource identifiers, or an isolated disposable Linear
project acknowledgement are missing. Do not point the hosted lane at an active
real project slug as a shortcut; existing Symphony runtimes may dispatch other
active issues from that project before the trial can prove external-project
isolation. When the hosted lane is explicitly enabled, it pushes the generated
project `main` branch to the configured disposable GitHub remote before
dispatch so `origin/main` is a real external base for worktree creation. A
hosted lane must not be counted as passed until it records the
tracker ticket identifier, final tracker state, branch, commit SHA, pushed
branch proof, PR URL, dashboard/API evidence, and Project Execution History
evidence for the external project.

### NIE-274 Recovered Ownership Evidence

The external Node trial exposed a recovery shape where setup or workspace
preflight created residue, the first session blocked, and a replacement session
later completed the tracker handoff. The corrected runtime behavior is:

- issue identifier: `NIE-274` deterministic regression coverage uses
  `NIE-RESIDUE`, `ABC-BLOCK-RESUME`, and `ABC-RESIDUE-RECOVERY`;
- first-session lineage: `thread-prev` / `turn-prev` / `session-prev`, and
  `thread-setup` / `turn-setup` / `session-setup`;
- replacement lineage: `thread-replacement` / `turn-replacement` /
  `session-replacement`;
- branch/PR evidence: record the actual feature branch, commit SHA, pushed
  branch proof, and PR URL in the ticket workpad/PR for each trial closure;
- dashboard/API evidence: `/api/v1/state` and issue detail must project the
  replacement thread/turn/session as the running or completed owner while late
  first-session events appear only under stale/quarantined diagnostics;
- Project Execution History evidence: the latest attempt and terminal outcome
  must reference the replacement attempt/session, not the blocked first
  session;
- setup-output classification: generated Node lockfiles such as
  `package-lock.json` are expected setup output for generated Node workflows,
  but when they appear as uncommitted issue-workspace residue after a blocked
  setup/preflight attempt they remain product friction surfaced as a workspace
  conflict until the operator or recovery path explicitly accepts attempt
  residue. True active Git operations and non-setup conflicts still fail closed.

The report classifies findings as:

- `implementation_defect`: Symphony behavior that must be fixed before a lane
  can pass.
- `product_friction`: usable behavior that still creates adoption friction.
- `environment_prerequisite`: missing local roots, build artifacts, command
  availability, git, hosted credentials, or API probes that require operator
  remediation.
- `intentional_out_of_scope`: deliberately skipped evidence such as
  `--no-dashboard`.
