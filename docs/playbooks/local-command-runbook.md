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

These commands are intentionally narrow in the Local Command and Setup PRD:

```bash
symphony profile list
symphony profile show <pack-or-bundle>
symphony init --help
```

`profile list` exposes the composable profile registry: tracker, workspace,
toolchain, and workflow packs plus named bundles such as Linear/Node and
GitHub/Node. `profile show <pack-or-bundle>` prints registry metadata, intended
use, bundle expansion, conflict or required-dimension validation output, and
protected binding behavior. `symphony-internal` remains a protected binding to
the checked-in `WORKFLOW.md`, not a generated template. `init` only prints help
and must not generate, copy, or overwrite workflows until the init
materialization PRD is implemented.

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
