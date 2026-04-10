# PRD-007 Phase 2: GitHub Issues Adapter with PR Metadata

## Problem and Goals (SPEC Alignment)
Define Phase 2 extension to support GitHub Issues as an additional tracker source while preserving v1 orchestration invariants and normalized issue model parity.

SPEC anchors:
- Tracker adapter contract and normalization principles: Section 11
- Domain issue model: Section 4.1.1
- Core dispatch/reconciliation semantics that must remain unchanged: Section 7, 8

Goals:
- Add GitHub Issues read support without destabilizing Linear flow.
- Preserve single orchestrator policy path independent of tracker backend.
- Include PR linkage metadata in normalized issue context.

## Scope
In scope:
- GitHub tracker adapter implementing candidate fetch/state refresh.
- Normalization mapping from GitHub issue payloads to Symphony issue contract.
- PR metadata enrichment fields for prompts/UI diagnostics.

Out of scope:
- Orchestrator-native issue writes (comments/state transitions).
- Cross-repo workflow orchestration in first GitHub phase.

## Architecture and Ownership
Adapter architecture:
- `TrackerAdapter` interface remains stable.
- `LinearAdapter` (v1) and `GitHubIssuesAdapter` (phase 2) behind tracker kind switch.
- Shared normalization validation suite enforces parity.

GitHub-specific boundaries:
- Auth via GitHub token from environment/config.
- Repository/project scope config explicitly required.
- API pagination and rate-limit handling isolated in GitHub adapter.

## Public Interfaces and Data Contracts
Extended normalized issue contract for GitHub adapter:
```json
{
  "id": "github_node_or_issue_id",
  "identifier": "ORG/REPO#123",
  "title": "string",
  "state": "Open",
  "url": "https://github.com/org/repo/issues/123",
  "labels": ["bug"],
  "blocked_by": [],
  "tracker_meta": {
    "tracker_kind": "github",
    "repository": "org/repo",
    "pr_links": [
      {
        "number": 456,
        "url": "https://github.com/org/repo/pull/456",
        "state": "open",
        "merged": false
      }
    ]
  }
}
```

Configuration additions (phase 2):
- `tracker.kind: github`
- `tracker.api_key` (or github token alias)
- `tracker.owner`
- `tracker.repo`
- `tracker.active_states`
- `tracker.terminal_states`

## State, Failure, and Recovery Behavior
- Orchestrator state transitions remain unchanged by tracker kind.
- GitHub adapter failures map to tracker error categories parallel to Linear categories.
- Rate-limit exhaustion should skip dispatch for tick, preserve reconciliation behavior.

## Security Requirements
- Principle of least privilege for GitHub token scopes.
- No token leakage in logs/API.
- Restrict eligible repository scope to configured owner/repo.

## Acceptance Criteria and Conformance Tests
Required tests:
- Normalized issue contract parity against shared fixture suite.
- Candidate pagination and ordering correctness.
- PR metadata enrichment and null-handling when no linked PR exists.
- Error mapping for transport/status/payload failures.
- Orchestrator behavior consistency when switching tracker kinds.

Acceptance gates:
- Phase-2 adapter passes all shared tracker contract tests.
- Existing Linear regression suite remains green.

## Operational Readiness and Rollout Gates
- Feature flag for GitHub adapter enablement.
- Production rollout requires staged validation on non-critical repository.
- Rate-limit telemetry visible on local dashboard/API.
