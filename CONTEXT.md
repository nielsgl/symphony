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

**Linear Attachment Upload**:
The Linear GraphQL-backed attachment upload flow that Symphony uses when Linear MCP cannot express the required upload behavior.
_Avoid_: Routine Linear GraphQL use

**Issue Runtime Override**:
A workflow-governed request for issue-specific Codex runtime settings, validated before dispatch.
_Avoid_: Model override when referring to the broader concept

**Project Execution History**:
Durable project-level history of Symphony issue runs, attempts, threads, turns, state transitions, telemetry, and operator actions across restarts.
_Avoid_: Live state, dashboard cache

**Conversation Archive**:
Durable archived agent conversation content for audit, review, and workflow improvement.
_Avoid_: App server event ledger, live event stream

**Effective Model**:
The model actually used by the **Codex App Server** for a turn after all defaults, overrides, and reroutes are resolved.
_Avoid_: Requested model

## Relationships

- A **Codex Runner** integrates one **Codex App Server** process.
- A **Codex Runner** is one implementation of the **Agent Runner** role.
- An **Agent Runner** may be implemented by runtimes other than the **Codex App Server**.
- The **Extension Spec** may add Symphony-local behavior without modifying the **Reference Spec**.
- An **App Server Event Ledger** preserves **Codex App Server** messages without making every message an orchestrator state transition.
- **Linear Attachment Upload** is the canonical exception for using `linear_graphql` instead of Linear MCP.
- An **Issue Runtime Override** may affect **Codex Runner** startup, but only after workflow policy validates it.
- **Project Execution History** includes **App Server Event Ledger** entries as one source of audit evidence.
- A **Conversation Archive** may enrich **Project Execution History**, but it is distinct from protocol-level ledger entries.
- **Project Execution History** records the **Effective Model** for accurate token and cost analysis.

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

> **Dev:** "Can we rebuild project metrics by reading current live state?"
> **Domain expert:** "No. Use **Project Execution History** so metrics and audit trails survive restarts."

> **Dev:** "Is the **App Server Event Ledger** the full conversation transcript?"
> **Domain expert:** "No. The ledger records protocol evidence; the **Conversation Archive** stores conversation content for review."

> **Dev:** "The workflow requested GPT-5.5; should cost analytics use that?"
> **Domain expert:** "Use the **Effective Model** if the app-server rerouted or otherwise resolved a different model."

## Flagged ambiguities

- "Codex app-server integration" was used to mean both the external **Codex App Server** surface and Symphony's **Codex Runner** adapter; resolved: these are distinct concepts.
- "`SPEC.md` alignment" could mean editing the upstream **Reference Spec** or mapping against it; resolved: the **Reference Spec** is read-only for this work.
