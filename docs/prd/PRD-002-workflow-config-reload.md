# PRD-002 Workflow and Config Reload

## Problem and Goals (SPEC Alignment)
Define deterministic loading, resolution, validation, and hot reload of `WORKFLOW.md` so runtime behavior can be safely changed without service restart while preserving last-known-good behavior.

SPEC anchors:
- Workflow file contract and front matter schema: Section 5
- Config precedence/resolution/reload/preflight: Section 6
- Core conformance checklist items for loader/reload/typed config: Section 18.1

Goals:
- Strict parse + strict template render behavior.
- Typed config getters with defaults and env indirection.
- Runtime-safe reload with no orchestrator crash on invalid changes.

## Scope
In scope:
- Workflow path resolution precedence.
- YAML front matter and prompt body split.
- Front matter typed conversion and defaulting.
- `$VAR` and path resolution semantics.
- Hot-reload detection + re-application.
- Startup and per-tick dispatch validation.

Out of scope:
- UI editor for workflow file.
- Dynamic rebind of listener resources not required by core spec.

## Architecture and Ownership
`WorkflowConfig` ownership:
- `WorkflowLoader`: file I/O + parse.
- `ConfigResolver`: coercion, env resolution, defaults.
- `ConfigValidator`: startup and dispatch preflight checks.
- `WorkflowWatcher`: fs-change detection + debounced reload pipeline.
- `EffectiveConfigStore`: atomic last-known-good snapshot.

Reload transaction model:
1. Read + parse candidate workflow.
2. Resolve/coerce fields.
3. Validate.
4. If valid: atomically replace effective config + prompt template.
5. If invalid: retain previous config and emit operator-visible error event.

## Public Interfaces and Data Contracts
Key contracts:
```ts
type WorkflowDefinition = { config: Record<string, unknown>; prompt_template: string }
type EffectiveConfig = {
  tracker: TrackerConfig
  polling: { interval_ms: number }
  workspace: { root: string }
  hooks: HooksConfig
  agent: AgentConfig
  codex: CodexConfig
  server?: { port: number }
}
```

Validation result contract:
```json
{
  "ok": false,
  "error_code": "missing_tracker_api_key",
  "message": "tracker.api_key is required after env resolution",
  "at": "2026-04-10T10:00:00Z"
}
```

Preflight required checks:
- workflow file readable + parsable.
- supported `tracker.kind`.
- resolved tracker auth present.
- tracker project scope present where required.
- non-empty `codex.command`.

## State, Failure, and Recovery Behavior
- Missing/invalid workflow at startup: fail startup with typed error.
- Invalid reload during runtime: keep last-known-good config and continue operation.
- Per-tick preflight invalid: reconciliation runs, dispatch skipped.
- Template parse errors: surfaced as config/template errors.
- Template render errors: fail only affected run attempt.

Dynamic re-application matrix:
- Apply immediately to future ticks: poll interval, active/terminal states, concurrency limits.
- Apply to future launches: codex settings, hooks, workspace root/path config.
- Do not forcibly restart in-flight sessions for config changes.

## Security Requirements
- Do not log raw secret values from `$VAR` resolution.
- Path expansion applies only to path-intended fields.
- Unknown front matter keys ignored by default, preventing brittle upgrades.

## Acceptance Criteria and Conformance Tests
Required tests:
- Path precedence (explicit path over cwd default).
- YAML/no-YAML parse paths.
- Non-map front matter rejection.
- Strict template variable/filter behavior.
- `$VAR`, `~`, and path separator handling semantics.
- Invalid reload preserves previous effective config.
- Per-tick validation blocks dispatch but not reconciliation.

Acceptance gates:
- Section 17.1 tests fully passing.
- Reload latency under target threshold (<=2s from file change to effective config update).

## Operational Readiness and Rollout Gates
- Log effective config version hash on startup and successful reload.
- Emit reload failure events with typed error code.
- Provide local API field for current config version and last reload status.
