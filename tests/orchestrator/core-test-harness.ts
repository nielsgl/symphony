import { vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OrchestratorCore } from '../../src/orchestrator/core';
import { LocalApiServer } from '../../src/api';
import { SnapshotService } from '../../src/api/snapshot-service';
import type {
  OrchestratorConfig,
  OrchestratorPersistencePort,
  OrchestratorPorts,
  OrchestratorState,
  TranscriptToolCallDiagnostic,
  TranscriptToolCallLineage,
  WorkerTerminationResult
} from '../../src/orchestrator/types';
import type { StructuredLogger } from '../../src/observability';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
import { buildDurableIdentity } from '../../src/persistence/identity';
import { SqlitePersistenceStore } from '../../src/persistence/store';
import { toWorkerEvent } from '../../src/runtime';
import type { Issue, TrackerAdapter } from '../../src/tracker/types';
import type { ControlPlaneHealthSummary } from '../../src/api/control-plane-health';

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i-1',
    identifier: 'ABC-1',
    title: 'Issue ABC-1',
    description: null,
    priority: 2,
    state: 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

export function makeTracker(): TrackerAdapter & {
  fetch_candidate_issues: ReturnType<typeof vi.fn>;
  fetch_issues_by_states: ReturnType<typeof vi.fn>;
  fetch_issue_states_by_ids: ReturnType<typeof vi.fn>;
  create_comment: ReturnType<typeof vi.fn>;
  update_issue_state: ReturnType<typeof vi.fn>;
} {
  return {
    fetch_candidate_issues: vi.fn(async () => []),
    fetch_issues_by_states: vi.fn(async () => []),
    fetch_issue_states_by_ids: vi.fn(async () => []),
    create_comment: vi.fn(async () => undefined),
    update_issue_state: vi.fn(async () => undefined)
  };
}

export function makeTerminationResult(overrides: Partial<WorkerTerminationResult> = {}): WorkerTerminationResult {
  return {
    cancellation_supported: true,
    cancellation_requested: true,
    worker_settled: true,
    graceful_exit_observed: true,
    forced_kill_requested: false,
    forced_kill_settled: null,
    cleanup_requested: false,
    cleanup_succeeded: null,
    result: 'succeeded',
    reason_code: 'worker_cancel_graceful_exit',
    detail: 'worker process exited after graceful cancellation',
    ...overrides
  };
}

export function makeControlPlaneHealthSummary(
  health: 'ok' | 'slow' | 'large' | 'degraded',
  observedAtMs: number,
  overrides: Partial<ControlPlaneHealthSummary['endpoints'][number]> = {}
): ControlPlaneHealthSummary {
  const durationByHealth = {
    ok: 120,
    slow: 1_250,
    large: 120,
    degraded: 6_000
  };
  const payloadByHealth = {
    ok: 10_000,
    slow: 10_000,
    large: 1_500_000,
    degraded: 10_000
  };
  return {
    generated_at: new Date(observedAtMs).toISOString(),
    sample_limit: 40,
    thresholds: {
      slow_ms: 1_000,
      degraded_ms: 5_000,
      large_payload_bytes: 1_000_000,
      degraded_payload_bytes: 5_000_000
    },
    endpoint_count: 1,
    worst_health: health,
    endpoints: [
      {
        endpoint: '/api/v1/state',
        transport: 'http',
        sample_count: 1,
        health,
        last_observed_at: new Date(observedAtMs).toISOString(),
        last_duration_ms: durationByHealth[health],
        max_duration_ms: durationByHealth[health],
        avg_duration_ms: durationByHealth[health],
        last_payload_bytes: payloadByHealth[health],
        max_payload_bytes: payloadByHealth[health],
        avg_payload_bytes: payloadByHealth[health],
        last_projection_duration_ms: null,
        last_enrichment_duration_ms: null,
        last_enrichment_status: null,
        last_enrichment_degraded: null,
        last_enrichment_reason_code: null,
        last_serialization_duration_ms: null,
        last_broadcast_client_count: null,
        last_snapshot_age_ms: null,
        last_snapshot_freshness_state: null,
        last_snapshot_error_code: null,
        ...overrides
      }
    ]
  };
}

export interface Harness {
  orchestrator: OrchestratorCore;
  tracker: ReturnType<typeof makeTracker>;
  now: { value: number };
  scheduled: Map<string, { callback: () => Promise<void>; due_at_ms: number; handle: object }>;
  terminated: Array<{ issue_id: string; cleanup_workspace: boolean; reason: string }>;
  spawned: Array<{
    issue_id: string;
    attempt: number | null;
    worker_host?: string | null;
    resume_context?: string | null;
    recover_workspace_attempt_residue?: boolean;
  }>;
}

export function withTemporaryCodexHome<T>(callback: (codexHome: string) => Promise<T>): Promise<T> {
  const previousCodexHome = process.env.SYMPHONY_CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
  process.env.SYMPHONY_CODEX_HOME = codexHome;
  return callback(codexHome).finally(() => {
    if (previousCodexHome === undefined) {
      delete process.env.SYMPHONY_CODEX_HOME;
    } else {
      process.env.SYMPHONY_CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  });
}

export function writeSessionTranscript(codexHome: string, filename: string, records: unknown[]): string {
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const transcriptPath = path.join(sessionsDir, filename);
  fs.writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

export function createHarness(options: {
  configOverrides?: Partial<OrchestratorConfig>;
  spawnWorker?: OrchestratorPorts['spawnWorker'];
  recoverMissingToolOutput?: OrchestratorPorts['recoverMissingToolOutput'];
  terminateWorker?: OrchestratorPorts['terminateWorker'];
  submitBlockedIssueInputNative?: OrchestratorPorts['submitBlockedIssueInputNative'];
  resolveProgressSignals?: OrchestratorPorts['resolveProgressSignals'];
  logger?: StructuredLogger;
  persistence?: OrchestratorPersistencePort;
  getControlPlaneHealth?: OrchestratorPorts['getControlPlaneHealth'];
  getHostLoad?: OrchestratorPorts['getHostLoad'];
} = {}): Harness {
  const tracker = makeTracker();
  const now = { value: 1_000_000 };
  const scheduled = new Map<string, { callback: () => Promise<void>; due_at_ms: number; handle: object }>();
  const terminated: Array<{ issue_id: string; cleanup_workspace: boolean; reason: string }> = [];
  const spawned: Array<{
    issue_id: string;
    attempt: number | null;
    worker_host?: string | null;
    resume_context?: string | null;
    recover_workspace_attempt_residue?: boolean;
  }> = [];

  const config: OrchestratorConfig = {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 2,
    max_concurrent_agents_by_state: {},
    max_retry_backoff_ms: 300_000,
    active_states: ['Todo', 'In Progress'],
    terminal_states: ['Done', 'Canceled', 'Cancelled'],
    stall_timeout_ms: 300_000,
    ...options.configOverrides
  };

  const spawnWorker: OrchestratorPorts['spawnWorker'] =
    options.spawnWorker ??
    (async ({ issue, attempt, worker_host, resume_context, recover_workspace_attempt_residue }) => {
      const worker_instance_id = `${issue.id}-worker-${spawned.length + 1}`;
      const worker_handle = { issue_id: issue.id, worker_instance_id };
      spawned.push({
        issue_id: issue.id,
        attempt,
        worker_host,
        resume_context,
        ...(recover_workspace_attempt_residue ? { recover_workspace_attempt_residue } : {})
      });
      return {
        ok: true,
        worker_handle,
        worker_instance_id,
        monitor_handle: worker_handle,
        worker_host
      };
    });

  const orchestrator = new OrchestratorCore({
    config,
    ports: {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      getControlPlaneHealth: options.getControlPlaneHealth,
      getHostLoad: options.getHostLoad,
      spawnWorker,
      recoverMissingToolOutput: options.recoverMissingToolOutput,
      terminateWorker:
        options.terminateWorker ??
        (async ({ issue_id, cleanup_workspace, reason }) => {
          terminated.push({ issue_id, cleanup_workspace, reason });
          return makeTerminationResult({ cleanup_requested: cleanup_workspace, cleanup_succeeded: cleanup_workspace ? true : null });
        }),
      scheduleRetryTimer: ({ issue_id, due_at_ms, callback }) => {
        const handle = { issue_id };
        scheduled.set(issue_id, { callback, due_at_ms, handle });
        return handle;
      },
      cancelRetryTimer: (timer_handle) => {
        for (const [issueId, scheduledEntry] of scheduled.entries()) {
          if (scheduledEntry.handle === timer_handle) {
            scheduled.delete(issueId);
          }
        }
      },
      submitBlockedIssueInputNative: options.submitBlockedIssueInputNative,
      resolveProgressSignals: options.resolveProgressSignals,
      notifyObservers: () => undefined
    },
    nowMs: () => now.value,
    logger: options.logger,
    persistence: options.persistence
  });

  return { orchestrator, tracker, now, scheduled, terminated, spawned };
}


export {
  CANONICAL_EVENT,
  LocalApiServer,
  OrchestratorCore,
  REASON_CODES,
  SnapshotService,
  SqlitePersistenceStore,
  buildDurableIdentity,
  fs,
  os,
  path,
  toWorkerEvent
};

export type {
  Issue,
  OrchestratorPersistencePort,
  OrchestratorPorts,
  OrchestratorState,
  StructuredLogger,
  TranscriptToolCallDiagnostic,
  TranscriptToolCallLineage
};
