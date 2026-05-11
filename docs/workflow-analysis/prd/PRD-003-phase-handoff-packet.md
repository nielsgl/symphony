# PRD-003 Phase Handoff Packet

## Problem Statement

Each Symphony phase iteration repeatedly rediscovers workflow context: issue state, branch state, PR state, validation evidence, workflow rules, skill guidance, and known blockers. The analysis found thousands of discovery-category commands across ticket iterations.

From the user's perspective, a review or merge run should start from a concise, trustworthy handoff rather than rereading stable context and reconstructing the ticket state from scratch.

## Solution

Create a compact phase handoff packet emitted at the end of each phase and loaded at the start of the next run iteration. The packet captures the current ticket state, phase result, validation summary, PR summary, evidence artifacts, blocker status, workflow rules already applied, and next action.

The packet must include source hashes and drift checks so later phases can trust only the parts that remain current.

## User Stories

1. As an agent, I want a compact handoff packet at run start, so that I can avoid broad rediscovery.
2. As an agent, I want the packet to include current issue state, so that I know the intended phase.
3. As an agent, I want PR metadata in the packet, so that I do not repeat PR discovery unless it changed.
4. As an agent, I want validation evidence summarized in the packet, so that I know what can be reused.
5. As an agent, I want known blockers listed, so that repair work starts from the actual failure.
6. As an agent, I want source hashes in the packet, so that I can detect stale context.
7. As a reviewer, I want the implementation handoff to show what changed and what was validated, so that review can focus on behavior.
8. As an operator, I want packet drift reasons, so that stale handoffs are explainable.
9. As a maintainer, I want handoff packets to be small, so that they reduce rather than increase token usage.
10. As a maintainer, I want unchanged workflow guidance referenced by hash, so that repeated skill and playbook reads are not necessary.
11. As an operator, I want the latest packet visible on the ticket detail view, so that manual inspection starts from the same state as the agent.
12. As an agent, I want partial invalidation, so that one stale PR field does not discard all useful context.

## Implementation Decisions

- Build a deep `Phase Handoff Packet` module with create, validate, drift-check, and summarize operations.
- Packets are attached to ticket, phase, run iteration, branch head, tracker status, PR head, and validation ledger snapshot.
- Packet validation returns valid, partially stale, or stale with reasons.
- The Orchestrator loads the latest packet before broad discovery.
- Drift checks are narrow and cheap: tracker status, branch head, PR head, validation identity, and evidence artifact availability.
- Packets reference large evidence by stable identifier rather than embedding full logs.
- The Local API exposes the latest packet state and drift status.
- Dashboard ticket detail shows packet summary and stale sections.

## Testing Decisions

- Unit tests cover packet creation, compact summary generation, and drift classification.
- Unit tests cover partial invalidation of PR, tracker, validation, and branch sections.
- Integration tests cover implementation-to-review and review-to-merge packet handoff.
- Regression tests cover stale branch head, stale PR head, changed tracker state, and missing evidence artifact.
- Tests should assert that unchanged sections remain reusable when one section is stale.

## Out of Scope

- Replacing the ticket ledger; packets depend on the ledger from PRD-001.
- Replacing validation identity; packets consume validation summaries from PRD-002.
- Publishing packet contents to Linear or GitHub by default.
- Storing full command output or full transcript in the packet.

## Further Notes

This PRD is local only and was not published to any issue tracker. It should materially reduce repeated context discovery if packet size is kept intentionally small.
