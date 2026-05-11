# Symphony

Symphony orchestrates tracker-backed coding work by dispatching issues into isolated workspaces and running agent sessions through an adapter boundary.

## Language

**Codex App Server**:
The external Codex protocol server exposed by `codex app-server`.
_Avoid_: Codex runner, agent runner

**Codex Runner**:
Symphony's adapter around the **Codex App Server** protocol.
_Avoid_: App server, agent runner

**Agent Runner**:
The spec-level execution role that runs an agent session for an issue.
_Avoid_: Codex runner when referring to the generic spec role

**Reference Spec**:
The upstream OpenAI-provided Symphony contract in `SPEC.md`.
_Avoid_: Local spec, extension spec

**Extension Spec**:
Symphony's local extension contract in `SPEC.ext.md`.
_Avoid_: Reference spec

**App Server Event Ledger**:
A bounded, redacted per-run record of raw **Codex App Server** protocol messages used for diagnostics and dashboard enrichment.
_Avoid_: Orchestrator state, canonical events

**App Server Event Ledger Lite**:
The MVP form of the **App Server Event Ledger** that persists bounded summaries, typed high-value fields, and redaction/truncation metadata without storing full raw payloads by default.
_Avoid_: Full transcript archive

**Linear Attachment Upload**:
The Linear GraphQL-backed attachment upload flow that Symphony uses when Linear MCP cannot express the required upload behavior.
_Avoid_: Routine Linear GraphQL use

**Issue Runtime Override**:
A workflow-governed request for issue-specific Codex runtime settings, validated before dispatch.
_Avoid_: Model override when referring to the broader concept

**Project Execution History**:
Durable project-level history of Symphony issue runs, attempts, threads, turns, state transitions, telemetry, and operator actions across restarts.
_Avoid_: Live state, dashboard cache

**Project Identity**:
The stable repository/workflow identity used to group **Project Execution History** across restarts and local runs.
_Avoid_: Runtime database path, tracker project alone

**Workspace Provisioning Boundary**:
The rule that Symphony's Workspace Manager owns filesystem workspace and Git worktree creation, while the **Codex Runner** only passes the provisioned `cwd` to the **Codex App Server**.
_Avoid_: App-server worktree creation

**Tracker Ticket**:
The product-facing unit of work from a tracker that can move through implementation, review, repair, handoff, and merge phases.
_Avoid_: Codex thread, run attempt

**Ticket Identity**:
The stable tracker identity used to group all runs for one **Tracker Ticket** within a **Project Identity**.
_Avoid_: Issue identifier alone

**Ticket Orchestration Ledger**:
The **Project Execution History** view that groups all run attempts, phases, validation evidence, PR state, blockers, costs, and outcomes for one tracker ticket.
_Avoid_: Codex thread history

**Project History Consumer Summary**:
A compact read-only **Project Execution History** projection for review and future workflow consumers, derived from durable ticket/run facts without triggering validation reuse, handoff packets, drain mode, or operator steering.
_Avoid_: Phase Handoff Packet, Validation Ledger behavior

**Validation Ledger**:
The **Project Execution History** record of validation commands, evidence identities, results, reuse decisions, and invalidation reasons.
_Avoid_: Test cache when referring to auditable validation evidence

**Advisory Validation Reuse**:
The first **Validation Ledger** behavior where prior validation evidence can be cited or recommended for reuse, but checks are not silently skipped without explicit ledger-backed reasoning.
_Avoid_: Automatic test skipping

**Phase Handoff Packet**:
A compact derived artifact that summarizes current ticket state, validation evidence, blockers, drift checks, and next action for the next phase.
_Avoid_: Durable source of truth

**Handoff Note**:
An agent-authored narrative note that may feed a **Phase Handoff Packet** but is not the canonical packet itself.
_Avoid_: Phase handoff packet

**Repair Loop Policy**:
The **Improve Work** policy that evaluates repeated phase loops and returns continue, narrow repair, escalate, or block outcomes.
_Avoid_: Automatic cancellation

**Governed Merge Preflight**:
A Symphony-owned tooling/API surface that returns structured readiness data for governed submit and merge flows.
_Avoid_: Skill-only merge probing

**Conversation Archive**:
Durable archived agent conversation content for audit, review, and workflow improvement.
_Avoid_: App server event ledger, live event stream

**Operational History**:
The mandatory non-transcript portion of **Project Execution History**: project, ticket, run, phase, state, telemetry, validation, protocol summaries, and operator facts.
_Avoid_: Conversation archive

**Dashboard Evidence Surface**:
The shared API/dashboard presentation layer for feature-owned evidence such as history, app-server timelines, validation records, handoff packets, repair state, and operator actions.
_Avoid_: Separate dashboard mega-PRD

**Project History View**:
The MVP **Dashboard Evidence Surface** for **Project Execution History**, showing one row per **Tracker Ticket** and a ticket detail timeline.
_Avoid_: Analytics dashboard, transcript viewer

**Effective Model**:
The model actually used by the **Codex App Server** for a turn after all defaults, overrides, and reroutes are resolved.
_Avoid_: Requested model

**Symphony Workflow Platform**:
The umbrella product program for making Symphony easier to adopt, easier to understand, and better at improving its own agent workflow.
_Avoid_: Single giant PRD, unrelated backlog streams

**Adopt Symphony**:
The PRD track for local setup, project onboarding, profiles, `doctor`, `init`, and multi-project readiness.
_Avoid_: Public distribution when referring to the local-first adoption track

**Understand Work**:
The PRD track for durable history, ledgers, telemetry, auditability, and dashboard/API views of what happened.
_Avoid_: Live dashboard state

**Improve Work**:
The PRD track for active orchestration improvements such as validation reuse, handoff packets, repair-loop controls, steering, fast paths, and governed merge preflight.
_Avoid_: Observability-only work

**Operator Intervention Controls**:
The **Improve Work** feature area for audited operator actions against active runs, such as steering an active Codex turn.
_Avoid_: Passive dashboard inspection

**Advisory Native Review**:
An optional **Improve Work** feature that invokes Codex App Server native review as an Agent Review sub-step without giving it tracker state authority.
_Avoid_: Agent Review replacement

**Workflow Platform PRDs**:
The final, canonical PRD set for the **Symphony Workflow Platform**, stored under `docs/prd/workflow-platform/`.
_Avoid_: Analysis PRDs

**SWP ID**:
The stable identifier format for a canonical **Workflow Platform PRD**, written as `SWP-###`.
_Avoid_: Analysis-local PRD numbers

**PRD Dependency Graph**:
The explicit dependency structure between **Workflow Platform PRDs**, later materialized as Linear blockers when PRDs become implementation issues.
_Avoid_: Strict serial roadmap

**Doctor MVP**:
The local readiness diagnostic surface for command setup, workflow validity, environment, tracker credentials, Codex availability, workspace configuration, git safety, ports, and high-trust consent.
_Avoid_: History diagnostics

**Doctor History Diagnostics**:
The later diagnostic extension for **Project Execution History** storage, schema migrations, ledger ingestion, retention, and redaction health.
_Avoid_: Doctor MVP

**Safe Runtime Upgrade**:
The **Improve Work** capability for draining active work, reaching quiescence, and restarting/upgrading the Symphony runtime without manually timing around active agents.
_Avoid_: In-process code hot swap

**Drain Mode**:
The runtime state where Symphony stops dispatching new work while allowing active runs to finish, hand off, or reach a safe restart boundary.
_Avoid_: Shutdown

**Quiescence**:
The **Drain Mode** condition where Symphony can be safely stopped or upgraded because no active worker, Codex process, tracker write, unflushed ledger write, or unpersisted retry state remains.
_Avoid_: All tickets complete

**Upgrade Script Integration**:
A later capability that composes drain, source update, dependency install/build, and process restart for a specific local deployment setup.
_Avoid_: Drain Mode v1

**Project-Owned Customization**:
Future versioned project-owned Symphony skills and prompt fragments, likely under `.symphony/skills/` and `.symphony/prompts/`.
_Avoid_: MVP profile materialization

## Relationships

- A **Codex Runner** integrates one **Codex App Server** process.
- A **Codex Runner** is one implementation of the **Agent Runner** role.
- An **Agent Runner** may be implemented by runtimes other than the **Codex App Server**.
- The **Extension Spec** may add Symphony-local behavior without modifying the **Reference Spec**.
- `SPEC.md` is authoritative for base behavior; `SPEC.ext.md` is authoritative for current local extension behavior.
- Analysis documents are source material, not normative requirements for **Workflow Platform PRDs**.
- If analysis documents conflict with `CONTEXT.md` decisions from the grilling session, `CONTEXT.md` terminology and decisions win for final SWP synthesis.
- After **Workflow Platform PRDs** exist, analysis documents should remain in place as evidence with supersession notes pointing to canonical SWP docs.
- An **App Server Event Ledger** preserves **Codex App Server** messages without making every message an orchestrator state transition.
- **Linear Attachment Upload** is the canonical exception for using `linear_graphql` instead of Linear MCP.
- An **Issue Runtime Override** may affect **Codex Runner** startup, but only after workflow policy validates it.
- **Project Execution History** includes **App Server Event Ledger** entries as one source of audit evidence.
- **Project Execution History** includes the **Ticket Orchestration Ledger**, **Validation Ledger**, and optional **Conversation Archive**.
- **Project Execution History** is grouped by **Project Identity**.
- **Project Identity** is based on the resolved project root plus active workflow path, with workflow hash and repository remote stored as evidence.
- **Workspace Provisioning Boundary** keeps current Symphony Git worktree creation in place; app-server `cwd`, `thread/fork`, and `thread/resume` are not treated as native workspace provisioning.
- A **Tracker Ticket** corresponds to the base spec **Issue** entity, but the term emphasizes product-level work across phases.
- **Ticket Identity** includes tracker kind, tracker project or equivalent scope when available, stable remote issue id, and human issue identifier.
- The **Ticket Orchestration Ledger** is keyed by **Project Identity** plus **Ticket Identity**, not by issue identifier alone.
- A **Phase Handoff Packet** is derived from **Project Execution History**; it is not the primary durable record.
- Symphony owns **Phase Handoff Packet** schema, storage, drift checks, and rendering; a **Handoff Note** may be one input.
- **App Server Event Ledger Lite** belongs in **Project Execution History** MVP; full raw payload persistence and **Conversation Archive** do not.
- **Operational History** is mandatory in **Project Execution History** MVP.
- A **Conversation Archive** may enrich **Project Execution History**, but it is distinct from protocol-level ledger entries.
- **Conversation Archive** is a later privacy-sensitive PRD with redacted and opt-in unredacted tiers.
- **Operational History** and **App Server Event Ledger Lite** persist by default with local project scope, bounded payloads, redaction/truncation metadata, and retention knobs.
- Unredacted **Conversation Archive** is opt-in, local-only, retention-limited, and excluded from exports by default.
- **Project Execution History** records the **Effective Model** for accurate token and cost analysis.
- **Project Execution History** MVP persists token and **Effective Model** facts but defers cost analytics until pricing snapshot/version/confidence semantics are defined.
- **Project History View** MVP includes a tracker-ticket table and ticket detail timeline; cohort analytics, cost estimates, validation reuse UI, and transcript viewing are later.
- Each feature PRD owns its minimal **Dashboard Evidence Surface** changes; dashboard consistency is coordinated in the **Workflow Platform PRDs** README.
- **Symphony Workflow Platform** is organized into **Adopt Symphony**, **Understand Work**, and **Improve Work** tracks.
- **Understand Work** provides the durable evidence that **Improve Work** uses to make safer orchestration decisions.
- **Adopt Symphony** must preserve the strong internal workflow while making local multi-project use approachable.
- **Workflow Platform PRDs** are the canonical implementation planning artifacts; `docs/analysis/prd/` and `docs/workflow-analysis/prd/` remain source-analysis material.
- Each **Workflow Platform PRD** uses an **SWP ID** to avoid colliding with analysis-local PRD numbering.
- The first **Workflow Platform PRDs** artifact is `docs/prd/workflow-platform/README.md`, which defines the roadmap, source map, tracks, dependency graph, sequencing, deferred features, and cross-cutting rules before individual SWP files are drafted.
- **Workflow Platform PRDs** should define a **PRD Dependency Graph** so independent tracks can run in parallel while blocked work remains explicit.
- Initial **SWP ID** sequence: `SWP-001` protocol hardening, `SWP-002` project execution history, `SWP-003` safe runtime upgrade/drain mode, `SWP-004` local command/setup, `SWP-005` project layout/config boundaries, `SWP-006` doctor MVP, `SWP-007` profile registry/init materialization, `SWP-008` validation ledger, `SWP-009` phase handoff packets, `SWP-010` repair-loop policy, `SWP-011` governed submit/merge preflight, `SWP-012` simple-task fast path, `SWP-013` operator intervention controls, `SWP-014` issue runtime override, `SWP-015` advisory native review, `SWP-016` conversation archive, and `SWP-017` local multi-project trial.
- `SWP-017` local multi-project trial is the **Adopt Symphony** acceptance gate; it depends on `SWP-004` through `SWP-007`, not on all lower-numbered **Improve Work** PRDs.
- `SWP-007` uses generated root `WORKFLOW.md` content as the MVP customization surface; **Project-Owned Customization** is reserved for later.
- **Codex App Server** protocol hardening is the first implementation gate before **Project Execution History** ingests protocol events.
- `SWP-001` includes runtime behavior hardening, not only tests: unknown approval-like requests must not be generically auto-approved.
- The first **Understand Work** implementation slice is **Project Execution History** MVP with **Ticket Orchestration Ledger** as the first view.
- **Safe Runtime Upgrade** is an early **Improve Work** priority after **Project Execution History**; v1 uses **Drain Mode** and safe restart, not in-process code hot swapping.
- **Drain Mode** stops new dispatch immediately, waits by default for active runs to reach **Quiescence**, and reports active blockers preventing safe restart.
- **Drain Mode** v1 exposes safe drain/status/shutdown controls but does not run `git pull`, install/build, or restart automation; **Upgrade Script Integration** is later.
- **Validation Ledger**, **Phase Handoff Packet**, and repair-loop policy depend on **Project Execution History** and should not be folded into the MVP.
- **Validation Ledger** starts with **Advisory Validation Reuse** and fails closed when identity or freshness is incomplete.
- **Simple Task Fast Path** depends on **Advisory Validation Reuse**, not fully automatic validation skipping.
- **Repair Loop Policy** uses soft escalation by default; hard blocking requires explicit workflow configuration.
- **Governed Merge Preflight** is implemented as Symphony runtime/tooling with stable structured output; skills call it but do not own its behavior.
- **Doctor MVP** can ship before **Project Execution History**.
- **Doctor History Diagnostics** depends on **Project Execution History**.
- **Operator Intervention Controls** depend on protocol hardening, **Project Execution History**, **App Server Event Ledger Lite**, and active run/thread/turn projection.
- **Advisory Native Review** depends on protocol hardening, **Project Execution History**, governed review/merge phase modeling, and **Fresh Dispatch State** semantics.
- **Advisory Native Review** records findings in history but never directly changes tracker state.
- **Issue Runtime Override** is an **Improve Work** feature; profile/init support may later generate example configuration but does not own the runtime behavior.
- The first **Issue Runtime Override** version is label/policy based, not free-form issue text.

## Example dialogue

> **Dev:** "Should the **Agent Runner** know about `thread/start`?"
> **Domain expert:** "No. `thread/start` belongs to the **Codex App Server** protocol and should be hidden behind the **Codex Runner**."

> **Dev:** "Should we patch the **Reference Spec** with Codex-specific app-server details?"
> **Domain expert:** "No. Keep `SPEC.md` read-only and record local interpretation or feature commitments in the **Extension Spec** or analysis docs."

> **Dev:** "Should `item/plan/delta` become an orchestrator state transition?"
> **Domain expert:** "No. Store it in the **App Server Event Ledger** and promote it later only if orchestration needs it."

> **Dev:** "Can we use `linear_graphql` for normal issue comments?"
> **Domain expert:** "No. Use Linear MCP for routine operations; reserve `linear_graphql` for **Linear Attachment Upload** and similar GraphQL-only gaps."

> **Dev:** "The ticket asks for a larger model. Should the **Codex Runner** use it?"
> **Domain expert:** "Only if it is a valid **Issue Runtime Override** allowed by workflow policy."

> **Dev:** "Should `symphony init` own per-ticket model selection?"
> **Domain expert:** "No. **Issue Runtime Override** belongs to **Improve Work**; init may only generate example policy later."

> **Dev:** "Can we rebuild project metrics by reading current live state?"
> **Domain expert:** "No. Use **Project Execution History** so metrics and audit trails survive restarts."

> **Dev:** "Is project history keyed only by the active SQLite database?"
> **Domain expert:** "No. Use **Project Identity** based on project root and workflow path, with workflow hash and repo remote as evidence."

> **Dev:** "Can Codex App Server replace Symphony's Git worktree creation?"
> **Domain expert:** "No. Preserve the **Workspace Provisioning Boundary**: Symphony creates worktrees, and Codex receives the provisioned `cwd`."

> **Dev:** "Can we key ticket history by `NIE-123`?"
> **Domain expert:** "Not by itself. Use **Ticket Identity** so identifiers from different projects or trackers do not collide."

> **Dev:** "Is the **Ticket Orchestration Ledger** separate from **Project Execution History**?"
> **Domain expert:** "No. It is the ticket-level view inside **Project Execution History**."

> **Dev:** "Should the first history PRD also implement validation reuse and handoff packets?"
> **Domain expert:** "No. Start with **Project Execution History** MVP and **Ticket Orchestration Ledger**; make validation and handoff later consumers."

> **Dev:** "Can history ingestion start before app-server protocol hardening?"
> **Domain expert:** "No. Harden **Codex App Server** request handling and generated-shape compatibility first, then ingest protocol events into history."

> **Dev:** "Is the **App Server Event Ledger** the full conversation transcript?"
> **Domain expert:** "No. The ledger records protocol evidence; the **Conversation Archive** stores conversation content for review."

> **Dev:** "Does the first history slice need full conversation storage?"
> **Domain expert:** "No. **Operational History** is mandatory first; **Conversation Archive** is a later privacy-sensitive layer."

> **Dev:** "Should the first history slice store full app-server payloads?"
> **Domain expert:** "No. Use **App Server Event Ledger Lite** with bounded summaries and typed fields; keep full payload and transcript archive as separate opt-in work."

> **Dev:** "Should all dashboard improvements become one separate PRD?"
> **Domain expert:** "No. Each feature owns its **Dashboard Evidence Surface** while the PRD README keeps the surfaces consistent."

> **Dev:** "The workflow requested GPT-5.5; should cost analytics use that?"
> **Domain expert:** "Use the **Effective Model** if the app-server rerouted or otherwise resolved a different model."

> **Dev:** "Should all of these improvement ideas become one huge PRD?"
> **Domain expert:** "No. Treat them as the **Symphony Workflow Platform** with separate **Adopt Symphony**, **Understand Work**, and **Improve Work** PRD tracks."

> **Dev:** "Should we rewrite the analysis PRDs in place?"
> **Domain expert:** "No. Create canonical **Workflow Platform PRDs** under `docs/prd/workflow-platform/` and leave analysis PRDs as source material."

> **Dev:** "Can the final PRDs reuse `PRD-001` from the analysis folders?"
> **Domain expert:** "No. Use **SWP ID** values like `SWP-001` for canonical workflow-platform PRDs."

> **Dev:** "Should we create all SWP PRDs immediately?"
> **Domain expert:** "No. First create `docs/prd/workflow-platform/README.md` as the canonical roadmap and dependency map."

> **Dev:** "Does the PRD order mean every item must run serially?"
> **Domain expert:** "No. Use the **PRD Dependency Graph** and Linear blockers to run independent tracks in parallel."

> **Dev:** "Should hot reload mean swapping Node code inside the running process?"
> **Domain expert:** "No. Start with **Safe Runtime Upgrade**: **Drain Mode**, quiescence detection, and safe restart. True in-process hot swap is out of scope for v1."

> **Dev:** "Does quiescent mean every ticket is finished?"
> **Domain expert:** "No. **Quiescence** means no active runtime work would be stranded by restart; queued or future ticket work may remain."

> **Dev:** "Should `doctor` wait until history exists?"
> **Domain expert:** "No. Ship **Doctor MVP** for local readiness first; add **Doctor History Diagnostics** after history exists."

> **Dev:** "Should init implement project-owned skill loading now?"
> **Domain expert:** "No. `SWP-006` materializes visible `WORKFLOW.md` content; **Project-Owned Customization** is reserved for later."

> **Dev:** "Should `turn/steer` be part of the history MVP?"
> **Domain expert:** "No. Treat it as **Operator Intervention Controls** under **Improve Work**, and record its actions in history."

> **Dev:** "Can native Codex review replace Agent Review?"
> **Domain expert:** "No. **Advisory Native Review** can feed Agent Review, but the review role still interprets findings and routes tracker state."

## Flagged ambiguities

- "Codex app-server integration" was used to mean both the external **Codex App Server** surface and Symphony's **Codex Runner** adapter; resolved: these are distinct concepts.
- "`SPEC.md` alignment" could mean editing the upstream **Reference Spec** or mapping against it; resolved: the **Reference Spec** is read-only for this work.
