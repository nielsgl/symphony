import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'stress-control-plane.js');

const cleanupPaths: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  for (const cleanupPath of cleanupPaths.splice(0)) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(tempDir);
  return tempDir;
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port');
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function runStress(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function writeJson(response: http.ServerResponse, payload: unknown): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function controlPlane(queueDelayMs: number) {
  return {
    sample_limit: 40,
    thresholds: {
      slow_ms: 1000,
      degraded_ms: 5000,
      slow_request_queue_delay_ms: 1000,
      degraded_request_queue_delay_ms: 5000,
      slow_event_loop_delay_ms: 1000,
      degraded_event_loop_delay_ms: 5000,
      large_payload_bytes: 1_000_000,
      degraded_payload_bytes: 5_000_000
    },
    endpoint_count: 2,
    worst_health: queueDelayMs > 1000 ? 'slow' : 'ok',
    event_loop: {
      observed_at: '2026-05-19T10:00:00.000Z',
      sample_window_ms: 1000,
      delay: { resolution_ms: 20, min_ms: 0, mean_ms: 1, max_ms: 2, p50_ms: 1, p95_ms: 2, p99_ms: 2 },
      utilization: { idle_ms: 999, active_ms: 1, utilization: 0.001 }
    },
    endpoints: [
      {
        endpoint: '/api/v1/state',
        transport: 'http',
        sample_count: 1,
        health: queueDelayMs > 1000 ? 'slow' : 'ok',
        last_observed_at: '2026-05-19T10:00:00.000Z',
        last_duration_ms: 4,
        max_duration_ms: 4,
        avg_duration_ms: 4,
        last_payload_bytes: 1200,
        max_payload_bytes: 1200,
        avg_payload_bytes: 1200,
        last_request_queue_delay_ms: queueDelayMs,
        max_request_queue_delay_ms: queueDelayMs,
        avg_request_queue_delay_ms: queueDelayMs,
        last_projection_duration_ms: 2,
        last_enrichment_duration_ms: 0,
        last_enrichment_status: 'ok',
        last_enrichment_degraded: false,
        last_enrichment_reason_code: null,
        last_serialization_duration_ms: 1,
        last_broadcast_client_count: null,
        last_snapshot_age_ms: 0,
        last_snapshot_freshness_state: 'fresh',
        last_snapshot_error_code: null,
        last_event_loop_delay_ms: 2,
        max_event_loop_delay_ms: 2,
        avg_event_loop_delay_ms: 2,
        last_event_loop_utilization: 0.001
      }
    ]
  };
}

function statePayload(queueDelayMs: number) {
  return {
    generated_at: '2026-05-19T10:00:00.000Z',
    counts: { running: 1, retrying: 0, blocked: 0 },
    health: { dispatch_validation: 'ok', last_error: null, control_plane: controlPlane(queueDelayMs) },
    running: [
      {
        issue_identifier: 'NIE-179',
        codex_session_transcript_scan_budget: {
          exhausted: true,
          reason_codes: ['transcript_probe_byte_budget_exhausted'],
          candidate_count: 4,
          files_considered: 4,
          limits: { max_discovery_files: 20, max_scan_bytes: 262_144 }
        },
        transcript_tool_call_diagnostic_summary: { total_count: 1 }
      }
    ]
  };
}

function diagnosticsPayload(queueDelayMs: number, codexHome = '/tmp/codex') {
  return {
    control_plane: controlPlane(queueDelayMs),
    runtime_resolution: { effective_codex_home: codexHome },
    running: [
      {
        codex_session_transcript_scan_budget: {
          exhausted: true,
          reason_codes: ['transcript_probe_byte_budget_exhausted'],
          candidate_count: 4,
          files_considered: 4,
          limits: { max_discovery_files: 20, max_scan_bytes: 262_144 }
        }
      }
    ]
  };
}

function issueDiagnosticsPayload(callId = 'call_stress_stress-thread-stress-turn') {
  return {
    issue_identifier: 'NIE-179',
    status: 'running',
    runtime_diagnostics: {
      issue_identifier: 'NIE-179',
      status: 'running',
      terminal_source: 'session_transcript',
      codex_session_transcript_scan_budget: {
        exhausted: true,
        reason_codes: ['transcript_probe_byte_budget_exhausted'],
        candidate_count: 4,
        files_considered: 4,
        limits: { max_discovery_files: 20, max_scan_bytes: 262_144 }
      },
      transcript_tool_call_diagnostics: {
        metadata: { total_available_count: 2, included_count: 2, limit: 50, offset: 0, has_more: false },
        records: [
          { call_id: callId, kind: 'function_call', lineage: 'active_owned' },
          { call_id: callId, kind: 'function_call_output', lineage: 'active_owned' }
        ]
      },
      tool_call_ledger: {
        metadata: { total_available_count: 1, included_count: 1, limit: 50, offset: 0, has_more: false },
        records: [
          {
            call_id: callId,
            completion_status: 'completed',
            evidence_sources: ['session_transcript'],
            start_evidence_source: 'session_transcript',
            completion_evidence_source: 'session_transcript'
          }
        ]
      }
    }
  };
}

describe('stress-control-plane historical corpus mode', () => {
  it('keeps the default hot transcript mode available without scanner evidence', async () => {
    const codexHome = makeTempDir('symphony-stress-codex-test-');
    const artifactDir = makeTempDir('symphony-stress-artifacts-');
    const { url } = await listen((request, response) => {
      if (request.url === '/api/v1/state') {
        writeJson(response, {
          generated_at: '2026-05-19T10:00:00.000Z',
          counts: { running: 0, retrying: 0, blocked: 0 },
          health: { dispatch_validation: 'ok', last_error: null, control_plane: controlPlane(1) },
          running: []
        });
        return;
      }
      if (request.url === '/api/v1/diagnostics') {
        writeJson(response, { control_plane: controlPlane(1), running: [] });
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    const result = await runStress([
      '--codex-home',
      codexHome,
      '--api-url',
      `${url}/api/v1/state`,
      '--duration-ms',
      '30',
      '--probe-interval-ms',
      '10',
      '--corpus-files',
      '1',
      '--seed-records-per-file',
      '1',
      '--artifact-dir',
      artifactDir,
      '--json'
    ]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.mode).toBe('hot-transcript');
    expect(summary.scanner_evidence.engaged).toBe(false);
    expect(summary.endpoints['/api/v1/diagnostics'].successes).toBeGreaterThan(0);
  });

  it('probes state and diagnostics concurrently and writes scanner evidence artifacts', async () => {
    const codexHome = makeTempDir('symphony-stress-codex-test-');
    const artifactDir = makeTempDir('symphony-stress-artifacts-');
    const { url } = await listen((request, response) => {
      if (request.url === '/api/v1/state') {
        writeJson(response, statePayload(3));
        return;
      }
      if (request.url === '/api/v1/diagnostics') {
        writeJson(response, diagnosticsPayload(3, codexHome));
        return;
      }
      if (request.url?.startsWith('/api/v1/issues/NIE-179/diagnostics')) {
        writeJson(response, issueDiagnosticsPayload());
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    const result = await runStress([
      '--historical-corpus',
      '--codex-home',
      codexHome,
      '--api-url',
      `${url}/api/v1/state`,
      '--issue-identifier',
      'NIE-179',
      '--duration-ms',
      '40',
      '--probe-interval-ms',
      '10',
      '--corpus-files',
      '4',
      '--seed-records-per-file',
      '1',
      '--append-interval-ms',
      '100',
      '--artifact-dir',
      artifactDir,
      '--artifact-name',
      'summary.json',
      '--keep-corpus',
      '--json'
    ]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.mode).toBe('historical-corpus');
    expect(summary.endpoints['/api/v1/state'].successes).toBeGreaterThan(0);
    expect(summary.endpoints['/api/v1/diagnostics'].successes).toBeGreaterThan(0);
    expect(summary.endpoints['/api/v1/issues/:id/diagnostics'].successes).toBeGreaterThan(0);
    expect(summary.scanner_evidence.engaged).toBe(true);
    expect(summary.codex_home_match).toBe(true);
    expect(summary.active_transcript_evidence).toMatchObject({
      expected_call_id: 'call_stress_stress-thread-stress-turn',
      tool_call_seen: true,
      tool_call_completed: true,
      terminal_seen: true,
      evidence_source: 'session_transcript'
    });
    expect(summary.corpus.dates).toEqual(['2026/05/07', '2026/05/13']);
    expect(summary.corpus.generated_historical_files).toBe(4);
    expect(fs.existsSync(path.join(codexHome, 'sessions', '2026', '05', '07'))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'sessions', '2026', '05', '13'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(artifactDir, 'summary.json'), 'utf8'))).toMatchObject({
      mode: 'historical-corpus',
      scanner_evidence: { engaged: true }
    });
  });

  it('fails the gate when observed queue latency exceeds threshold', async () => {
    const codexHome = makeTempDir('symphony-stress-codex-test-');
    const artifactDir = makeTempDir('symphony-stress-artifacts-');
    const { url } = await listen((request, response) => {
      if (request.url === '/api/v1/state') {
        writeJson(response, statePayload(50));
        return;
      }
      if (request.url === '/api/v1/diagnostics') {
        writeJson(response, diagnosticsPayload(50, codexHome));
        return;
      }
      if (request.url?.startsWith('/api/v1/issues/NIE-179/diagnostics')) {
        writeJson(response, issueDiagnosticsPayload());
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    const result = await runStress([
      '--historical-corpus',
      '--codex-home',
      codexHome,
      '--api-url',
      `${url}/api/v1/state`,
      '--issue-identifier',
      'NIE-179',
      '--duration-ms',
      '30',
      '--probe-interval-ms',
      '10',
      '--corpus-files',
      '1',
      '--seed-records-per-file',
      '1',
      '--max-queue-delay-ms',
      '10',
      '--artifact-dir',
      artifactDir,
      '--json'
    ]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout);
    expect(summary.queue_latency.max_ms).toBe(50);
    expect(summary.threshold_failures).toContain('queue_latency_exceeded');
  });

  it('fails historical mode when scanner diagnostics come from a different Codex home', async () => {
    const codexHome = makeTempDir('symphony-stress-codex-test-');
    const artifactDir = makeTempDir('symphony-stress-artifacts-');
    const { url } = await listen((request, response) => {
      if (request.url === '/api/v1/state') {
        writeJson(response, statePayload(3));
        return;
      }
      if (request.url === '/api/v1/diagnostics') {
        writeJson(response, diagnosticsPayload(3, '/tmp/unrelated-codex'));
        return;
      }
      if (request.url?.startsWith('/api/v1/issues/NIE-179/diagnostics')) {
        writeJson(response, issueDiagnosticsPayload());
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    const result = await runStress([
      '--historical-corpus',
      '--codex-home',
      codexHome,
      '--api-url',
      `${url}/api/v1/state`,
      '--issue-identifier',
      'NIE-179',
      '--duration-ms',
      '30',
      '--probe-interval-ms',
      '10',
      '--corpus-files',
      '1',
      '--seed-records-per-file',
      '1',
      '--artifact-dir',
      artifactDir,
      '--json'
    ]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout);
    expect(summary.scanner_evidence.engaged).toBe(true);
    expect(summary.codex_home_match).toBe(false);
    expect(summary.threshold_failures).toContain('codex_home_mismatch');
  });

  it('fails historical mode when active transcript evidence is missing', async () => {
    const codexHome = makeTempDir('symphony-stress-codex-test-');
    const artifactDir = makeTempDir('symphony-stress-artifacts-');
    const { url } = await listen((request, response) => {
      if (request.url === '/api/v1/state') {
        writeJson(response, statePayload(3));
        return;
      }
      if (request.url === '/api/v1/diagnostics') {
        writeJson(response, diagnosticsPayload(3, codexHome));
        return;
      }
      if (request.url?.startsWith('/api/v1/issues/NIE-179/diagnostics')) {
        writeJson(response, {
          runtime_diagnostics: {
            status: 'running',
            transcript_tool_call_diagnostics: { metadata: {}, records: [] },
            tool_call_ledger: { metadata: {}, records: [] }
          }
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    const result = await runStress([
      '--historical-corpus',
      '--codex-home',
      codexHome,
      '--api-url',
      `${url}/api/v1/state`,
      '--issue-identifier',
      'NIE-179',
      '--duration-ms',
      '30',
      '--probe-interval-ms',
      '10',
      '--corpus-files',
      '1',
      '--seed-records-per-file',
      '1',
      '--artifact-dir',
      artifactDir,
      '--json'
    ]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout);
    expect(summary.active_transcript_evidence.tool_call_seen).toBe(false);
    expect(summary.threshold_failures).toContain('active_transcript_evidence_missing');
  });
});
