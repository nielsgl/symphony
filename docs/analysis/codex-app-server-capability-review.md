# Codex App Server Capability Review

Status: Draft

This document reviews Symphony's use of the Codex App Server, maps that usage against the read-only OpenAI-provided `SPEC.md`, compares it with the Elixir reference implementation in `../symphony-ref`, and identifies app-server capabilities that could improve Symphony's orchestration, workflow, telemetry, and dashboard.

## Reproduction

Generated contract inputs for this review:

```bash
codex app-server generate-ts --out /tmp/symphony-codex-appserver-ts --experimental
codex app-server generate-json-schema --out /tmp/symphony-codex-appserver-schema --experimental
```

The generated bindings and schema are review inputs only. They are not vendored into this repository in this pass.

## Scope

This review inventories the full generated Codex App Server surface at category level, then deep-dives the portions that can materially affect Symphony:

- Core runner lifecycle
- Operator control
- Observability
- Workflow power
- Dashboard and control-plane opportunities
- Security posture

## Domain Terms

- **Codex App Server**: the external Codex protocol server exposed by `codex app-server`.
- **Codex Runner**: Symphony's adapter around the **Codex App Server** protocol.
- **Agent Runner**: the spec-level execution role that runs an agent session for an issue.
- **Reference Spec**: the upstream OpenAI-provided Symphony contract in `SPEC.md`.
- **Extension Spec**: Symphony's local extension contract in `SPEC.ext.md`.
- **App Server Event Ledger**: a bounded, redacted per-run record of raw **Codex App Server** protocol messages used for diagnostics and dashboard enrichment.
- **Linear Attachment Upload**: the Linear GraphQL-backed attachment upload flow that Symphony uses when Linear MCP cannot express the required upload behavior.
- **Issue Runtime Override**: a workflow-governed request for issue-specific Codex runtime settings, validated before dispatch.
- **Project Execution History**: durable project-level history of Symphony issue runs, attempts, threads, turns, state transitions, telemetry, and operator actions across restarts.
- **Conversation Archive**: durable archived agent conversation content for audit, review, and workflow improvement.
- **Effective Model**: the model actually used by the **Codex App Server** for a turn after all defaults, overrides, and reroutes are resolved.

## Authority

`SPEC.md` is read-only for this work. Alignment against it is a conformance map, not an edit target.

Codex-specific interpretation, feature ideas, and local product commitments belong in this analysis document first. If a behavior becomes a Symphony-local contract, it should move into `SPEC.ext.md`.

## Prioritization Model

- **Adopt now**: high product value, low or moderate integration risk.
- **Prototype**: high product value, uncertain protocol or product fit.
- **Harden current usage**: already used, but fragile, under-typed, or insufficiently tested.
- **Defer**: low product value, high risk, or outside Symphony's role.

Priority order:

1. Protocol safety hardening: approval allowlist, generated-contract tests, dynamic-tool containment, sandbox shape verification.
2. Event ledger and observability: raw app-server event capture, dashboard alerts, richer timelines.
3. Diagnostics enrichment: model, rate-limit, MCP, skills, hooks, plugin, and app visibility.
4. Operator controls: `turn/steer` and live thread inspection.
5. Workflow features: **Issue Runtime Override**, native `review/start`, and thread goals.
6. Deferred surfaces: marketplace management, account login flows, realtime APIs, and general filesystem/process APIs.

## Generated Capability Inventory

The generated client request surface includes these categories:

| Category | Examples | Initial Symphony posture |
| --- | --- | --- |
| Core lifecycle | `initialize`, `thread/start`, `thread/read`, `thread/resume`, `turn/start`, `turn/interrupt`, `turn/steer` | Deep dive |
| Thread control | `thread/list`, `thread/turns/list`, `thread/metadata/update`, `thread/goal/set`, `thread/rollback`, `thread/fork`, `thread/compact/start` | Mixed: adopt/prototype selectively |
| Operator requests | approval requests, permission requests, user-input requests, MCP elicitations, dynamic tool calls | Deep dive |
| Observability notifications | token usage, plan/diff updates, item lifecycle, reasoning/message deltas, warnings, model reroutes | Deep dive |
| MCP | `mcpServerStatus/list`, `mcpServer/tool/call`, `mcpServer/resource/read`, OAuth notifications | Prototype selectively |
| Account and model | `account/read`, `account/rateLimits/read`, `model/list`, `modelProvider/capabilities/read` | Diagnostics only |
| Skills, hooks, plugins, apps | `skills/list`, `hooks/list`, plugin and app marketplace/config APIs | Mostly defer; inspect for workflow UX opportunities |
| Filesystem/process/command | `fs/*`, `process/*`, `command/exec*` | Defer unless a clear dashboard/operator use case emerges |
| Realtime and remote control | realtime audio/text, remote-control status | Defer |
| Platform/auth/setup | login/logout, device keys, Windows sandbox setup, external agent config | Defer except degraded diagnostics |

Generated server requests include:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`
- `item/tool/call`
- `account/chatgptAuthTokens/refresh`
- legacy `execCommandApproval`
- legacy `applyPatchApproval`

Generated server notifications include high-value dashboard and forensics signals:

- Thread and turn lifecycle: `thread/started`, `thread/status/changed`, `turn/started`, `turn/completed`
- Usage and capacity: `thread/tokenUsage/updated`, `account/rateLimits/updated`
- Work progress: `turn/plan/updated`, `turn/diff/updated`, `item/started`, `item/completed`
- Streaming detail: `item/agentMessage/delta`, `item/plan/delta`, reasoning deltas, command/file-change output deltas
- Tooling and MCP: `item/mcpToolCall/progress`, `mcpServer/startupStatus/updated`
- Safety and drift: `warning`, `guardianWarning`, `deprecationNotice`, `configWarning`, `model/rerouted`

## Current Symphony Integration Map

Symphony integrates the Codex App Server through a small number of high-leverage seams:

| Area | Current usage | Main files | Review verdict |
| --- | --- | --- | --- |
| Command construction | Builds the configured `codex app-server` command, preserves user-provided Codex args, and normalizes the `app-server` subcommand position. | `src/codex/command-builder.ts`, `src/workflow/resolver.ts` | Conformant; keep tests around typed model selection and shell argument handling. |
| App-server lifecycle | Spawns the app-server subprocess in the per-issue workspace, sends `initialize`/`initialized`, starts a thread, starts turns, continues recovery turns, and interrupts active turns. | `src/codex/runner.ts`, `tests/codex/runner.test.ts` | Conformant core path; needs generated-contract drift tests for the exact emitted payloads. |
| Thread metadata | Calls `thread/read` after `turn/start` to fetch active thread metadata such as `Thread.updatedAt` for dashboard activity. | `src/codex/runner.ts`, `src/api/snapshot-service.ts` | Good pattern: explicit protocol reads are better than opportunistic startup payloads. Keep this as the model for future metadata features. |
| Sandbox and approval policy | Emits thread-level sandbox and turn-level `sandboxPolicy`, plus approval policy values from workflow config. | `src/codex/runner.ts`, workflow resolver tests | Functional, but should be verified against generated `SandboxMode`, `SandboxPolicy`, and `AskForApproval` shapes. |
| Server requests | Handles command/file approvals, dynamic tool calls, user-input prompts, MCP elicitations, and legacy approval methods. | `src/codex/runner.ts`, `tests/codex/runner.test.ts` | Highest hardening need: replace substring approval detection and unknown approval-like auto-approval with a method allowlist. |
| Dynamic tools | Advertises and handles only `linear_graphql`, with shape fallback when app-server capability negotiation rejects dynamic tools. | `src/codex/dynamic-tools.ts`, `src/codex/runner.ts` | Keep narrow. The canonical justification is **Linear Attachment Upload** and other Linear MCP gaps, not broad dynamic tool expansion. |
| Token and rate-limit telemetry | Parses `thread/tokenUsage/updated`, turn completion usage variants, and rate-limit payloads into normalized runner/orchestrator events. | `src/codex/runner.ts`, `src/orchestrator/core.ts`, `src/api/types.ts` | Good product value; should be backed by app-server notification shape tests and persisted snapshots for history. |
| Dashboard projection | Exposes current app-server PID, thread activity metadata, recent events, rate limits, token data, and issue/run state. | `src/api/*`, `src/orchestrator/core.ts` | Useful current-state view; missing durable project history and protocol-level event ledger. |
| Persistence | Stores normalized Symphony run state/events, but not a dedicated raw app-server event ledger. | `src/persistence/*`, `src/orchestrator/core.ts` | Do not overload `run_events`; add `app_server_events` or bounded per-run JSONL later. |
| Reference/debug evidence | Tests assert lifecycle payloads, dynamic tool handling, token accounting, and selected event projection. | `tests/codex/runner.test.ts`, `tests/orchestrator/*`, `tests/api/*` | Coverage exists, but it is mostly hand-shaped. Add generated-contract compatibility tests for critical shapes. |

## Current Integration Verdict

- **Conformant core lifecycle**: Symphony appears broadly aligned on launch, initialize, `thread/start`, `turn/start`, continuation turns, timeout handling, interrupt handling, token/rate-limit extraction, and dynamic tool execution.
- **Needs hardening**: approval handling, unsupported server requests, sandbox payload shape validation, dynamic tool contract alignment, and generated-contract drift tests need focused review.
- **Underused observability**: generated notifications such as plan/diff updates, item lifecycle, command/file-change output deltas, warnings, model reroutes, and MCP status are not yet fully captured or surfaced.
- **Promising later features**: `turn/steer`, thread goals, native `review/start`, diagnostics queries, and **Issue Runtime Overrides** could materially improve Symphony.
- **Intentionally deferred**: broad dynamic-tool expansion, plugin/app marketplace management, account login flows, realtime APIs, and general filesystem/process APIs are outside near-term Symphony priorities.

## API Usage Matrix

The comprehensive reference matrix lives in `docs/analysis/codex-app-server-api-matrix.md`.

For each app-server API entry, capture:

- API name
- Direction: client request, server request, or server notification
- Current Symphony status: used, partially used, observed only, not used, deferred
- Current usage location
- Purpose in Symphony
- Risk notes
- History value: none, low, medium, or high
- Recommendation: harden, adopt, prototype, diagnostics only, defer

This matrix is the durable reference for which Codex App Server APIs Symphony uses, how it uses them, and which APIs are intentionally out of scope.

Prefer generating or refreshing the matrix from `codex app-server generate-ts --experimental` output so method coverage does not silently rot as the app-server evolves.

### App Server Event Ledger

Recommendation: introduce an **App Server Event Ledger** as a bounded diagnostic projection of raw Codex App Server notifications, server requests, and client responses.

The ledger should not replace canonical orchestrator events. The orchestrator should continue to make scheduling, retry, cancellation, and blocked-input decisions from explicit normalized signals. The ledger should preserve richer app-server detail for forensics and dashboard timelines, then promote stable event types into canonical Symphony events only when they become operationally meaningful.

The ledger should distinguish:

- Notifications such as `turn/plan/updated`, `item/started`, `item/completed`, `thread/tokenUsage/updated`, warnings, and model events.
- Server requests such as approvals, dynamic tool calls, MCP elicitations, user-input requests, and permission requests.
- Client responses such as approval decisions, dynamic tool results, auto-answer modes, and unsupported-request failures.

Ledger payloads must be redacted before persistence, especially command output, diffs, tool arguments, MCP content, reasoning text, account/auth payloads, and raw operator input.

The ledger should use a separate persistence surface rather than overloading the existing `run_events` table. `run_events` is Symphony's normalized event feed; app-server ledger entries need protocol-specific fields such as direction, method, request id, thread id, turn id, item id, payload class, redaction status, truncation metadata, and response latency. A future implementation should add either an `app_server_events` table or bounded per-run JSONL sidecar, then include a bounded excerpt in forensics bundles.

The ledger is intended to power Symphony-native live run visibility. Symphony should be able to show detailed current agent activity without depending on the separate `codex-dashboard` service. `codex-dashboard` may remain an optional deep-link target for full historical transcript inspection by `thread_id`, especially unredacted local-only review, but Symphony should own its run-level protocol timeline and dashboard rendering.

The ledger should also feed **Project Execution History**. Symphony should not depend on live in-memory state or slow external transcript reads to answer basic questions such as which issues ran, what attempts happened, which threads/turns were involved, how many tokens were used, where failures occurred, what operators did, and how workflow/tooling can be improved.

First UI shape:

- Raw operational timeline: method, direction, summary, timestamp, thread id, turn id, item id, and request id.
- Curated status strip: current turn status, current plan step when available, active command/tool when available, last warning/model reroute, and token/rate-limit snapshot.
- Detail drawer: redacted/truncated payload excerpt for the selected event.

Avoid cloning a full transcript viewer in the first version. Symphony's UI should emphasize operational state: what the agent is doing, why it is blocked, what Symphony decided, and what the operator can do next.

Persistence boundary:

- Persist bounded summaries and redacted/truncated excerpts from day one.
- Cap storage per run by event count and/or bytes.
- Include a bounded ledger excerpt in forensics export.
- Stream the same entries to the dashboard for live visibility.
- Avoid full unredacted payload persistence in Symphony by default.

First persistence target: SQLite.

Recommended table: `app_server_events`.

Recommended fields:

- `event_id`
- `run_id`
- `issue_id`, `issue_identifier`
- `thread_id`, `turn_id`, `item_id`, `request_id`
- `direction`: `client_request`, `server_request`, `server_notification`, `client_response`
- `method`
- `payload_class`
- `summary`
- `redacted_excerpt`
- `payload_bytes`
- `truncated`
- `redaction_mode`
- `at`

### Project Execution History

Recommendation: make durable **Project Execution History** a first-class product surface.

Problem: current operator experience loses too much practical history and metrics across Symphony restarts. The system has durable persistence pieces, but the product should preserve a project-level audit and analytics trail that can be reviewed at any time.

Expected history dimensions:

- Issues processed and tracker states observed.
- Run attempts, retries, completions, blocked states, cancellations, and handoffs.
- Codex thread ids, turn ids, and session ids.
- Token/cost telemetry and rate-limit snapshots over time.
- App-server protocol summaries from the **App Server Event Ledger**.
- Tool calls, approvals, user-input requests, warnings, model reroutes, and review outcomes.
- Operator actions such as resume, cancel, steer, override, and acknowledgment.

Product uses:

- Restart-proof dashboard history.
- Per-project audit trail.
- Failure and blocker analysis.
- Token and cost trend analysis.
- Workflow, prompt, skill, and tool improvement loops.

This should become a separate PRD after the Codex App Server review. It is larger than app-server integration because it touches persistence, API, dashboard, metrics, retention, privacy, and historical analytics.

Token analytics should prefer structured app-server telemetry over transcript-derived estimates:

1. `thread/tokenUsage/updated` absolute totals or equivalent generated schema shape.
2. Terminal turn usage from `turn/completed` when present.
3. Codex state SQLite fallback when available.
4. Transcript-derived estimates only as degraded/approximate.

Persist token snapshots over time, not only final totals, so Symphony can analyze token burn during stalls, long waits, tool failures, review loops, and prompt/tool changes.

Cost analytics should come after token analytics. First persist token totals, token deltas, cached input, reasoning output, context window, requested model, and **Effective Model**. Later estimated cost views must include a pricing snapshot/version and confidence label, and should be labeled as estimates unless sourced from an authoritative billing API.

### Conversation Archive

Recommendation: design **Conversation Archive** as a higher-level historical content layer, separate from raw app-server payload persistence.

Suggested tiers:

- **Operational history**: always persisted; issue, run, attempt, turn, telemetry, state, and operator facts.
- **Redacted conversation archive**: default-on or configurable; redacted message text, plan text, tool/command summaries, and token metadata.
- **Unredacted archive**: opt-in local-only mode; configurable retention; never included in exports by default.

The **Conversation Archive** should support audit and workflow improvement use cases such as prompt/tool refinement and token reduction analysis. It should not be implemented by making the **App Server Event Ledger** store every raw unredacted protocol payload.

## Reference Implementation Comparison

The Elixir reference implementation is a useful comparison point, but not a target architecture. It confirms the upstream contract's intended shape while Symphony's TypeScript implementation has already grown local dashboard, persistence, workflow, and review concerns beyond the reference app.

Confirmed common ground:

- Both launch `codex app-server` as a subprocess from the issue workspace.
- Both use app-server protocol messages for thread and turn lifecycle.
- Both advertise the optional `linear_graphql` dynamic tool when enabled.
- Both treat `thread/tokenUsage/updated` as the primary live token-usage signal.
- Both project app-server PID and protocol events into operator-visible status surfaces.
- Both keep app-server protocol compatibility subordinate to the targeted generated schema/version.

Useful reference-app ideas for Symphony:

- The reference dashboard/test surface explicitly humanizes a broad app-server event set, including approvals, dynamic tool requests/results, token usage, and rate-limit updates. Symphony should reuse that idea through the **App Server Event Ledger**, but with stronger persistence, redaction, and dashboard affordances.
- The reference `docs/token_accounting.md` reinforces the rule already captured here: use `thread/tokenUsage/updated.tokenUsage.total` as the live absolute total, treat `tokenUsage.last` as a delta, and avoid blindly summing mixed token sources.
- The reference app has direct tests for unsupported dynamic tool calls, supported tool failures, malformed protocol lines, partial JSON lines, safer approval behavior, and workspace cwd guards. Symphony should ensure its TypeScript runner has equivalent critical coverage.

Symphony-specific extensions beyond the reference:

- Durable **Project Execution History** and **Conversation Archive** product goals.
- Dashboard/API projections for project-level orchestration rather than a mostly terminal/status dashboard.
- Workflow-governed **Issue Runtime Overrides**.
- Potential operator interventions such as `turn/steer`.
- Optional native Codex `review/start` integration inside Symphony's Agent Review workflow.

## Reference Spec Alignment

`SPEC.md` already defines the app-server integration as a language-neutral contract and says the targeted Codex App Server protocol/schema is the source of truth for exact field names and supported shapes. Symphony's current implementation aligns with that intent on the core run path, while this review identifies local extensions that should live outside the read-only **Reference Spec** until they are stable enough for `SPEC.ext.md`.

Alignment map:

| Spec area | Current Symphony status | Review action |
| --- | --- | --- |
| App-server subprocess over stdio | Implemented via `src/codex/runner.ts` and command-builder tests. | Keep as conformant. |
| Per-issue workspace cwd | Implemented in runner/workspace launch path. | Preserve cwd guard tests and compare with reference app coverage. |
| Initialize, thread, turn lifecycle | Implemented with `initialize`, `initialized`, `thread/start`, `turn/start`, continuation/recovery turns, and `turn/interrupt`. | Add generated-contract drift checks. |
| App-server events to orchestrator | Implemented for normalized completion, token, rate-limit, approval, tool, and activity events. | Add a protocol ledger without changing canonical orchestration events. |
| Optional `linear_graphql` tool | Implemented. | Narrow the documented purpose to **Linear Attachment Upload** and other Linear MCP gaps. |
| Token accounting | Implemented from `thread/tokenUsage/updated` and fallbacks. | Persist token snapshots and **Effective Model** in history work. |
| Dynamic tool contract | Implemented for `linear_graphql`, with fallback when unsupported. | Contain; do not broaden first-slice. |
| Human/operator input | Current non-interactive behavior exists. | Add explicit unsupported-request policy and operator-required states where auto-answering is unsafe. |
| Observability | Partial. | Use **App Server Event Ledger** plus later history/archive PRDs. |
| Remote app-server mode | Mentioned in spec/reference. | Defer unless Symphony's remote runner requires it; local subprocess remains the current implementation focus. |

## Extension Spec Alignment

`SPEC.ext.md` currently defines Symphony-local handoff and fresh-dispatch semantics. It does not yet define app-server-specific extensions such as the **App Server Event Ledger**, **Project Execution History**, **Conversation Archive**, **Issue Runtime Override**, or **Effective Model**.

Current alignment:

| Extension area | Existing `SPEC.ext.md` coverage | App-server review relationship |
| --- | --- | --- |
| Handoff State | Normative. Defines role boundaries where the current automation role stops without treating the issue as complete. | Native `review/start` should be a sub-step inside Agent Review, not a state-transition authority. |
| Fresh Dispatch State | Normative. Requires independent run context for review/merge roles. | Avoid `thread/fork`, `thread/resume`, or `thread/inject_items` for fresh-dispatch role handoff unless this extension is deliberately revised. |
| Local Worker State-Refresh Order | Normative. Defines how completed turns reconcile tracker state before continuing. | `turn/steer`, thread goals, and native review must not bypass this order. |
| Workflow Config Fields | Normative only for `tracker.handoff_states` and `tracker.fresh_dispatch_states`. | **Issue Runtime Override** would need a new extension section if implemented. |
| Observability and history | Not currently defined beyond base spec references. | **App Server Event Ledger** and **Project Execution History** should become new extension sections or PRDs after the hardening slice. |

Recommended extension-spec sequence:

1. Do not edit `SPEC.ext.md` during the review.
2. After protocol hardening, add a focused **App Server Event Ledger** extension only if implementation work starts.
3. Treat **Project Execution History** and **Conversation Archive** as separate PRD-level work before making them normative.
4. Add **Issue Runtime Override** to `SPEC.ext.md` only after the label/policy model is chosen and validated.

## Extension Spec Opportunities

- **App Server Event Ledger**: likely extension-worthy after the design settles, because it adds a Symphony-local diagnostics concept.
- **Issue Runtime Override**: likely extension-worthy if implemented, because it adds workflow-governed issue-specific runtime behavior.
- Workflow-gated native Codex review: keep as an analysis backlog item until a prototype proves lifecycle, cost, failure, and routing semantics.

## Candidate Work Items

### First Implementation Slice

Recommended first slice after this review:

1. Add a generated-contract drift script for critical shapes only.
2. Replace substring approval detection with an allowlisted server-request dispatcher.
3. Add tests for unsupported `item/permissions/requestApproval` and unknown server requests.
4. Add tests for lifecycle, approval/input, interruption, and telemetry generated-shape compatibility.
5. Document the exact supported `linear_graphql` boundary around **Linear Attachment Upload**.

Dynamic tool shape checks are useful only if cheap to include in the same drift harness. They are not a first-slice priority because Symphony intentionally limits dynamic tool use to the existing `linear_graphql` path, and **Linear Attachment Upload** is handled through a script-backed flow.

Not first-slice:

- Plugin, app, and marketplace APIs.
- Realtime APIs.
- Filesystem, process, and command APIs.
- Broad dynamic-tool expansion or exhaustive `DynamicTool*` drift coverage.

This slice focuses on correctness and compatibility before dashboard, steering, native review, or runtime override feature work.

Larger history/archive work should not be pulled into this first slice. Recommended sequence:

1. Protocol hardening slice.
2. **App Server Event Ledger** MVP.
3. **Project Execution History** PRD.
4. **Conversation Archive** PRD or a dedicated section inside the history PRD.
5. Dashboard history and analytics features.

### Harden Current Usage

#### Replace generic approval fallback with allowlisted server-request handling

Priority: High.

Current code: `src/codex/runner.ts` treats unknown approval-like server requests as approved by returning `{ "approved": true }` after known method-specific cases are exhausted.

Generated contract evidence:

- `item/commandExecution/requestApproval` expects `CommandExecutionRequestApprovalResponse`.
- `item/fileChange/requestApproval` expects `FileChangeRequestApprovalResponse`.
- `item/permissions/requestApproval` expects `PermissionsRequestApprovalResponse` with granted permissions and scope.
- Legacy `execCommandApproval` and `applyPatchApproval` use their own response shapes.

Recommendation:

- Replace substring-based approval detection with an allowlist of supported server request methods.
- Return the exact generated response shape for each supported method.
- For unsupported server requests, return a structured unsupported/error response and emit `codex.protocol.unsupported_request`.
- Treat unsupported permission approval as blocked/operator-required unless Symphony explicitly implements a safe permission-grant policy.

Unsupported request policy:

- Unknown `item/tool/call`: return structured tool failure and continue.
- Unknown approval, permission, auth, or account request: do not approve or fabricate credentials; emit `codex.protocol.unsupported_request` and fail/block as operator-required.
- Unknown request method with an id: respond with a JSON-RPC error when supported, emit unsupported, and continue only if the app-server can proceed safely.
- Unknown notification method: capture in the **App Server Event Ledger** and ignore for orchestration unless later promoted.

#### Verify sandbox payloads against generated schema

Priority: Medium.

Current stance: keep Symphony's `sandbox` plus `sandboxPolicy` integration as the default path. Generated app-server types also support `permissions?: PermissionProfileSelectionParams`, but `permissions` cannot be combined with `sandbox` or `sandboxPolicy`; moving to permission profiles would be a local security model change.

Recommendation:

- Validate emitted `sandbox` and `sandboxPolicy` payloads against generated `SandboxMode` and `SandboxPolicy` shapes.
- Keep app-server permission profiles as a prototype, not default behavior.
- Explore a future mapping from Symphony security profiles to Codex permission profiles only after security semantics, operator UX, and config migration are explicit.

#### Contain dynamic tool compatibility risk

Priority: High.

Current stance: do not expand Symphony-owned dynamic tools for now. Historical issues with app-server dynamic tool payload shapes, especially around the `linear_graphql` path, make dynamic tool expansion a poor near-term priority.

Recommendation:

- Keep `linear_graphql` as a narrow exceptional escape hatch.
- Preserve **Linear Attachment Upload** as the canonical exception for `linear_graphql`.
- Require any new `linear_graphql` use to justify why Linear MCP cannot express it.
- Avoid adding new dynamic tools until the generated contract is enforced by tests.
- Prefer MCP/server-native tools for routine workflow operations.
- Treat MCP status/progress as diagnostics, not a reason to add generic dashboard-triggered MCP calls yet.
- Audit `DynamicToolSpec`, `DynamicToolCallParams`, and `DynamicToolCallResponse` against generated shapes only if this is cheap to include in the generated-contract test harness.

#### Add targeted generated-contract tests

Priority: High.

Recommendation:

- Add a script that regenerates app-server TypeScript bindings and JSON Schema into a temporary directory.
- Extract critical shapes only: `ThreadStartParams`, `TurnStartParams`, server requests, approval responses, dynamic tool specs/results, and token/rate-limit notifications.
- Add tests that compare Symphony emitted/requested shapes against generated types or schema snapshots.
- Fail CI on critical-shape drift, not on the full app-server surface.
- Keep runtime parsing tolerant, but remove unsafe generic fallbacks such as unknown approval auto-approval.

### Prototype

#### Add operator guidance with `turn/steer`

Priority: Later.

Generated contract evidence: `turn/steer` accepts `threadId`, `expectedTurnId`, and `input`, allowing a client to steer the active turn when the expected turn precondition still holds.

Current code: no `turn/steer` integration was found in `src/` or tests.

Potential product value:

- Let an operator send guidance to a currently running issue from the dashboard.
- Avoid killing and redispatching an otherwise healthy run just to provide a small correction.
- Preserve the active thread/turn context while making operator intervention explicit.

Prototype guardrails:

- Require active `thread_id` and current `turn_id`.
- Require an operator reason note.
- Fail closed if `expectedTurnId` no longer matches the active turn.
- Record the action in the **App Server Event Ledger** and emit a canonical audit event.
- Do not use `turn/steer` for blocked-input submission or stale-run recovery in the first prototype.

#### Set Codex thread goals from Symphony issue context

Priority: Later.

Generated contract evidence: `thread/goal/set` accepts `threadId`, `objective`, `status`, and `tokenBudget`; `ThreadGoal` reports objective, status, token budget, tokens used, and elapsed time.

Potential product value:

- Attach issue-level intent to the Codex thread for clearer thread inspection.
- Align Codex thread goal token budget with Symphony budget policy.
- Enrich dashboard issue detail with goal progress.

Boundary:

- Treat thread goals as Codex thread metadata, not Symphony orchestration truth.
- Do not use goal status as the source of tracker state, run completion, or handoff decisions.

#### Add advisory native Codex review with `review/start`

Priority: Later.

Generated contract evidence: `review/start` accepts a `threadId`, `target`, and optional delivery mode. Targets include `uncommittedChanges`, `baseBranch`, `commit`, and `custom`.

Potential product value:

- Add a native Codex review signal inside the existing Agent Review workflow.
- Compare app-server-native review findings against the current workflow prompt and checklist.
- Surface review output in the dashboard timeline and forensics.

Prototype boundary:

- Run as an optional, workflow-gated Agent Review sub-step, not as a replacement for the review role.
- Prefer automatic invocation by Symphony once enabled, so evidence is consistent rather than prompt-dependent.
- Prefer `baseBranch` when branch relationship is known; use `uncommittedChanges` for local workspace review.
- Store review activity in the **App Server Event Ledger**.
- Require the Agent Review role to interpret findings and decide tracker routing.
- Never let `review/start` directly transition tracker state.

Example policy sketch:

```yaml
review:
  codex_native_review:
    enabled: true
    target: base_branch
    fallback_target: uncommitted_changes
```

#### Consider context compaction for long-running attempts

Priority: Later.

Generated contract evidence: `thread/compact/start` can start compaction for a thread.

Boundary:

- Continuation inside one worker run should continue to use `turn/start` on the existing `threadId`.
- Fresh dispatch must not inherit prior private context, so do not use `thread/fork` for Agent Review fresh dispatch.
- Do not use `thread/inject_items` for workflow control initially.
- Treat `thread/rollback` as unsafe unless paired with workspace file rollback semantics.
- Consider `thread/compact/start` only for long-running attempts, with clear **App Server Event Ledger** evidence and dashboard visibility.

### Adopt Later

#### Query account rate limits for diagnostics

Priority: Later.

Generated contract evidence: `account/rateLimits/read` returns a backward-compatible `rateLimits` snapshot plus optional `rateLimitsByLimitId`; `account/rateLimits/updated` streams rate-limit updates.

Current code: Symphony passively consumes rate-limit data from worker events and exposes it through state/dashboard projections.

Recommendation:

- Add diagnostics-only rate-limit querying when a local Codex App Server is available.
- Cache and expose degraded states such as Codex unavailable, unauthenticated, and rate limits unavailable.
- Do not use app-server account limits as an automatic dispatch gate until account identity, multi-bucket semantics, model routing, and missing-auth behavior are designed explicitly.

#### Enrich dashboard thread inspection with `thread/read` and `thread/turns/list`

Priority: Later.

Generated contract evidence: `thread/read` can return a `Thread`; `thread/turns/list` returns paginated `Turn` records with item views, status, error, timestamps, and duration.

Current code: Symphony uses `thread/read` only for lightweight diagnostic thread activity. Thread diagnostics and forensics are primarily built from orchestrator state, durable execution graph records, transcript scans, and recent events.

Recommendation:

- Add a live thread inspector for currently running sessions using `thread/read` and `thread/turns/list`.
- Keep stopped-session diagnostics backed by the **App Server Event Ledger** and forensics bundles.
- Do not make app-server read availability mandatory for core `/api/v1/state`.

#### Surface app-server warnings and model reroutes

Priority: Soon after ledger.

Generated contract evidence: app-server notifications include `warning`, `guardianWarning`, `deprecationNotice`, `configWarning`, `model/rerouted`, and `model/verification`.

Recommendation:

- Capture these notifications in the **App Server Event Ledger** and raw event timeline.
- Promote selected events into dashboard alert rows: safety/security warnings, config warnings, deprecations, and model reroutes.
- On `model/rerouted`, update the **Effective Model** for the affected turn from `toModel`, persist both `fromModel` and `toModel`, and show the reroute as an alert rather than an error.
- Do not make these dispatch blockers by default.
- Consider policy knobs later only if real run evidence shows a need.

#### Add model and provider capability diagnostics

Priority: Later.

Generated contract evidence: `model/list` returns available models, `modelProvider/capabilities/read` reports provider capabilities such as namespace tools, image generation, and web search, and `model/rerouted` reports runtime model changes.

Recommendation:

- Expose configured model, effective model, available models when query succeeds, and provider capabilities when query succeeds.
- Surface `model/rerouted` as a runtime alert because the actual model differs from the requested model.
- Do not block dispatch on `model/list` initially.
- Consider optional strict model validation later for release or preflight profiles.

#### Expose skills, hooks, plugins, and app availability diagnostics

Priority: Low.

Generated contract evidence: app-server can list skills, hooks, plugins, apps, and related marketplace/config metadata.

Recommendation:

- Add diagnostics later so operators can see what the Codex environment sees.
- Do not block dispatch on missing skills/plugins by default.
- Consider strict validation only after critical workflow dependencies are explicitly modeled.
- Prefer explicit workflow/setup checks for required repo-local skills.

#### Prototype Issue Runtime Override

Priority: Later.

Potential product value: allow specific issues to request a smaller, cheaper, or stronger model based on expected complexity.

Initial boundary:

- Treat per-ticket model selection as a workflow-governed override, not arbitrary tracker text execution.
- Validate requested models against an allowlist or workflow policy before passing them to `turn/start`.
- Source the first version from tracker labels rather than free-form issue description.
- Fall back to workflow defaults for invalid overrides by default; block dispatch only in an explicit strict mode.
- Record requested and effective model in diagnostics.
- Surface model reroutes so operators can see when the app-server selected something different.
- Never pass unrecognized model or reasoning-effort values through to Codex.

Example policy sketch:

```yaml
runtime_overrides:
  labels:
    model:small:
      model: gpt-5.4-mini
      reasoning_effort: medium
    model:large:
      model: gpt-5.5
      reasoning_effort: high
```
