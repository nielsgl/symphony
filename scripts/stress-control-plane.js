#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const DEFAULTS = {
  apiUrl: 'http://127.0.0.1:61026/api/v1/state',
  diagnosticsUrl: '',
  durationMs: 30_000,
  probeIntervalMs: 250,
  probeTimeoutMs: 2_000,
  corpusFiles: 250,
  seedRecordsPerFile: 100,
  appendIntervalMs: 25,
  appendBatchLines: 25,
  appendPayloadBytes: 4096,
  maxP95Ms: 500,
  maxP99Ms: 1000,
  maxQueueDelayMs: 1000,
  maxTimeouts: 0,
  historicalDates: ['2026/05/07', '2026/05/13'],
  artifactDir: path.join('.symphony', 'stress-base')
};

function usage() {
  return `Usage:
  node scripts/stress-control-plane.js [options]

Required for realistic transcript churn:
  --codex-home <path>             Codex home used by the running Symphony process.

Common options:
  --api-url <url>                 State endpoint to probe. Default: ${DEFAULTS.apiUrl}
  --diagnostics-url <url>         Diagnostics endpoint to probe. Default: derived from --api-url.
  --duration-ms <number>          Total run duration. Default: ${DEFAULTS.durationMs}
  --probe-interval-ms <number>    Delay between /state probes. Default: ${DEFAULTS.probeIntervalMs}
  --probe-timeout-ms <number>     Per-probe timeout. Default: ${DEFAULTS.probeTimeoutMs}
  --corpus-files <number>         Synthetic historical JSONL files. Default: ${DEFAULTS.corpusFiles}
  --seed-records-per-file <n>     Records per historical file. Default: ${DEFAULTS.seedRecordsPerFile}
  --historical-corpus             Seed historical transcript files across multiple dates and require scanner evidence.
  --historical-dates <csv>        Date paths under sessions/. Default: ${DEFAULTS.historicalDates.join(',')}
  --append-interval-ms <number>   Delay between active transcript appends. Default: ${DEFAULTS.appendIntervalMs}
  --append-batch-lines <number>   Lines appended per batch. Default: ${DEFAULTS.appendBatchLines}
  --append-payload-bytes <number> Bytes per appended record payload. Default: ${DEFAULTS.appendPayloadBytes}
  --thread-id <id>                Active thread id for the hot transcript. Default: stress-thread
  --turn-id <id>                  Active turn id for the hot transcript. Default: stress-turn
  --session-id <id>               Active session id for the hot transcript. Default: <thread-id>-<turn-id>
  --append-terminal               Append a task_complete sentinel near the end.
  --max-p95-ms <number>           Fail if p95 exceeds this. Default: ${DEFAULTS.maxP95Ms}
  --max-p99-ms <number>           Fail if p99 exceeds this. Default: ${DEFAULTS.maxP99Ms}
  --max-queue-delay-ms <number>   Fail if observed request queue delay exceeds this. Default: ${DEFAULTS.maxQueueDelayMs}
  --max-timeouts <number>         Fail if timeout count exceeds this. Default: ${DEFAULTS.maxTimeouts}
  --artifact-dir <path>           Directory for JSON summary artifacts. Default: ${DEFAULTS.artifactDir}
  --artifact-name <name>          Artifact filename. Default: generated from mode and timestamp.
  --server-pid <number>           Running Symphony server PID to record in artifact metadata.
  --keep-corpus                   Do not delete generated files at exit.
  --json                          Print machine-readable summary.

Example:
  SYMPHONY_CODEX_HOME=/tmp/symphony-stress-codex npm run start:dashboard -- --port=61026
  node scripts/stress-control-plane.js --codex-home /tmp/symphony-stress-codex --duration-ms 60000 --append-terminal
`;
}

function parseArgs(argv) {
  const options = {
    ...DEFAULTS,
    codexHome: '',
    threadId: 'stress-thread',
    turnId: 'stress-turn',
    sessionId: '',
    appendTerminal: false,
    historicalCorpus: false,
    requireScannerEngagement: false,
    artifactName: '',
    serverPid: null,
    keepCorpus: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    const readNumber = () => {
      const raw = readValue();
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${arg} must be a non-negative number`);
      }
      return value;
    };

    switch (arg) {
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
        break;
      case '--api-url':
        options.apiUrl = readValue();
        break;
      case '--diagnostics-url':
        options.diagnosticsUrl = readValue();
        break;
      case '--codex-home':
        options.codexHome = path.resolve(readValue());
        break;
      case '--duration-ms':
        options.durationMs = readNumber();
        break;
      case '--probe-interval-ms':
        options.probeIntervalMs = readNumber();
        break;
      case '--probe-timeout-ms':
        options.probeTimeoutMs = readNumber();
        break;
      case '--corpus-files':
        options.corpusFiles = readNumber();
        break;
      case '--seed-records-per-file':
        options.seedRecordsPerFile = readNumber();
        break;
      case '--historical-corpus':
        options.historicalCorpus = true;
        options.requireScannerEngagement = true;
        break;
      case '--historical-dates':
        options.historicalDates = readValue()
          .split(',')
          .map((value) => value.trim().replace(/^\/+|\/+$/g, ''))
          .filter(Boolean);
        break;
      case '--append-interval-ms':
        options.appendIntervalMs = readNumber();
        break;
      case '--append-batch-lines':
        options.appendBatchLines = readNumber();
        break;
      case '--append-payload-bytes':
        options.appendPayloadBytes = readNumber();
        break;
      case '--thread-id':
        options.threadId = readValue();
        break;
      case '--turn-id':
        options.turnId = readValue();
        break;
      case '--session-id':
        options.sessionId = readValue();
        break;
      case '--append-terminal':
        options.appendTerminal = true;
        break;
      case '--max-p95-ms':
        options.maxP95Ms = readNumber();
        break;
      case '--max-p99-ms':
        options.maxP99Ms = readNumber();
        break;
      case '--max-queue-delay-ms':
        options.maxQueueDelayMs = readNumber();
        break;
      case '--max-timeouts':
        options.maxTimeouts = readNumber();
        break;
      case '--artifact-dir':
        options.artifactDir = path.resolve(readValue());
        break;
      case '--artifact-name':
        options.artifactName = readValue();
        break;
      case '--server-pid':
        options.serverPid = readNumber();
        break;
      case '--keep-corpus':
        options.keepCorpus = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.sessionId) {
    options.sessionId = `${options.threadId}-${options.turnId}`;
  }
  if (!options.diagnosticsUrl) {
    options.diagnosticsUrl = deriveDiagnosticsUrl(options.apiUrl);
  }
  if (!options.codexHome) {
    options.codexHome = path.join(os.tmpdir(), `symphony-stress-codex-${process.pid}`);
  }
  if (options.historicalDates.length === 0) {
    throw new Error('--historical-dates must include at least one date path');
  }
  return options;
}

function deriveDiagnosticsUrl(apiUrl) {
  if (apiUrl.endsWith('/api/v1/state')) {
    return `${apiUrl.slice(0, -'/api/v1/state'.length)}/api/v1/diagnostics`;
  }
  const parsed = new URL(apiUrl);
  parsed.pathname = '/api/v1/diagnostics';
  parsed.search = '';
  return parsed.toString();
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function makeRecord(payload) {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload
  })}\n`;
}

function writeSeedCorpus(options) {
  const mode = options.historicalCorpus ? 'historical-corpus' : 'hot-transcript';
  const dates = options.historicalCorpus ? options.historicalDates : ['2026/05/13'];
  const sessionsDirs = dates.map((date) => path.join(options.codexHome, 'sessions', ...date.split('/')));
  for (const sessionsDir of sessionsDirs) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
  const filler = 'x'.repeat(Math.max(0, options.appendPayloadBytes));
  const historicalFiles = [];

  for (let fileIndex = 0; fileIndex < options.corpusFiles; fileIndex += 1) {
    const sessionsDir = sessionsDirs[fileIndex % sessionsDirs.length];
    const dateLabel = dates[fileIndex % dates.length].replace(/\//g, '-');
    const threadId = `historical-thread-${String(fileIndex).padStart(5, '0')}`;
    const filePath = path.join(sessionsDir, `rollout-${dateLabel}-${threadId}.jsonl`);
    let content = makeRecord({ type: 'session_meta', id: threadId });
    for (let recordIndex = 0; recordIndex < options.seedRecordsPerFile; recordIndex += 1) {
      content += makeRecord({
        type: 'token_count',
        thread_id: threadId,
        turn_id: `historical-turn-${recordIndex}`,
        info: {
          total_token_usage: {
            input_tokens: recordIndex + 1,
            output_tokens: recordIndex + 2,
            total_tokens: recordIndex + 3
          }
        },
        filler
      });
    }
    fs.writeFileSync(filePath, content, 'utf8');
    historicalFiles.push({
      path: filePath,
      bytes: Buffer.byteLength(content, 'utf8'),
      records: options.seedRecordsPerFile + 1
    });
  }

  const activeSessionsDir = sessionsDirs[sessionsDirs.length - 1];
  const activePath = path.join(activeSessionsDir, `rollout-${options.threadId}.jsonl`);
  fs.writeFileSync(
    activePath,
    makeRecord({ type: 'session_meta', id: options.threadId, thread_id: options.threadId, session_id: options.sessionId }),
    'utf8'
  );
  return {
    mode,
    sessionsDirs,
    activePath,
    corpus: {
      mode,
      dates,
      generated_historical_files: historicalFiles.length,
      generated_historical_bytes: historicalFiles.reduce((sum, file) => sum + file.bytes, 0),
      generated_historical_records: historicalFiles.reduce((sum, file) => sum + file.records, 0),
      sample_historical_files: historicalFiles.slice(0, 5),
      active_transcript: activePath
    }
  };
}

function startTranscriptWriter(options, activePath) {
  const filler = 'y'.repeat(Math.max(0, options.appendPayloadBytes));
  let sequence = 0;
  let terminalWritten = false;
  const startedAt = performance.now();
  const timer = setInterval(() => {
    const elapsed = performance.now() - startedAt;
    let content = '';
    for (let index = 0; index < options.appendBatchLines; index += 1) {
      sequence += 1;
      content += makeRecord({
        type: 'token_count',
        thread_id: options.threadId,
        turn_id: options.turnId,
        session_id: options.sessionId,
        sequence,
        info: {
          total_token_usage: {
            input_tokens: sequence,
            output_tokens: sequence,
            total_tokens: sequence * 2
          }
        },
        filler
      });
    }
    if (options.appendTerminal && !terminalWritten && elapsed >= options.durationMs * 0.8) {
      terminalWritten = true;
      content += makeRecord({
        type: 'task_complete',
        thread_id: options.threadId,
        turn_id: options.turnId,
        session_id: options.sessionId,
        last_agent_message: 'stress terminal sentinel'
      });
    }
    fs.appendFileSync(activePath, content, 'utf8');
  }, Math.max(1, options.appendIntervalMs));

  return {
    stop() {
      clearInterval(timer);
    },
    stats() {
      return { appended_records: sequence, terminal_written: terminalWritten };
    }
  };
}

async function probeEndpoint(endpoint, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const durationMs = performance.now() - startedAt;
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      endpoint,
      url,
      ok: response.ok,
      status: response.status,
      durationMs,
      bytes: Buffer.byteLength(text),
      error: null,
      json
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    return {
      endpoint,
      url,
      ok: false,
      status: null,
      durationMs,
      bytes: 0,
      error: error && error.name === 'AbortError' ? 'timeout' : String(error),
      json: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runProbes(options) {
  const deadline = performance.now() + options.durationMs;
  const results = [];
  while (performance.now() < deadline) {
    const batch = await Promise.all([
      probeEndpoint('/api/v1/state', options.apiUrl, options.probeTimeoutMs),
      probeEndpoint('/api/v1/diagnostics', options.diagnosticsUrl, options.probeTimeoutMs)
    ]);
    results.push(...batch);
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.probeIntervalMs, remaining)));
  }
  return results;
}

function summarizeEndpoint(endpoint, probeResults) {
  const endpointResults = probeResults.filter((result) => result.endpoint === endpoint);
  const successes = endpointResults.filter((result) => result.ok);
  const failures = endpointResults.filter((result) => !result.ok);
  const timeouts = failures.filter((result) => result.error === 'timeout');
  const failureErrors = countBy(failures.map((result) => result.error ?? `http_${result.status ?? 'unknown'}`));
  const statusCounts = countBy(endpointResults.map((result) => String(result.status ?? result.error ?? 'unknown')));
  const latencies = successes.map((result) => result.durationMs);
  const bytes = successes.map((result) => result.bytes);
  return {
    total: endpointResults.length,
    successes: successes.length,
    failures: failures.length,
    timeouts: timeouts.length,
    failure_errors: failureErrors,
    status_counts: statusCounts,
    response_bytes: {
      min: bytes.length > 0 ? Math.min(...bytes) : null,
      max: bytes.length > 0 ? Math.max(...bytes) : null,
      avg: bytes.length > 0 ? Math.round(bytes.reduce((sum, value) => sum + value, 0) / bytes.length) : null
    },
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    max_ms: latencies.length > 0 ? Math.max(...latencies) : null
  };
}

function extractControlPlaneSummaries(probeResults) {
  const summaries = [];
  for (const result of probeResults) {
    const payload = result.json;
    const controlPlane = payload?.control_plane ?? payload?.health?.control_plane ?? null;
    if (controlPlane && typeof controlPlane === 'object') {
      summaries.push({
        source_endpoint: result.endpoint,
        observed_probe_duration_ms: Math.round(result.durationMs),
        control_plane: controlPlane
      });
    }
  }
  return summaries;
}

function extractQueueDelayMetrics(controlPlaneSummaries) {
  const values = [];
  for (const summary of controlPlaneSummaries) {
    const endpoints = Array.isArray(summary.control_plane?.endpoints) ? summary.control_plane.endpoints : [];
    for (const endpoint of endpoints) {
      for (const key of ['last_request_queue_delay_ms', 'max_request_queue_delay_ms', 'avg_request_queue_delay_ms']) {
        if (typeof endpoint?.[key] === 'number' && Number.isFinite(endpoint[key])) {
          values.push(endpoint[key]);
        }
      }
    }
  }
  return {
    observed_values: values,
    max_ms: values.length > 0 ? Math.max(...values) : null,
    p95_ms: percentile(values, 95),
    latest_control_plane: controlPlaneSummaries.at(-1)?.control_plane ?? null
  };
}

function extractScannerEvidence(probeResults) {
  const budgetsBySignature = new Map();
  let diagnosticSummaryCount = 0;
  let diagnosticRecordCount = 0;

  function visit(value) {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value.codex_session_transcript_scan_budget && typeof value.codex_session_transcript_scan_budget === 'object') {
      const budget = value.codex_session_transcript_scan_budget;
      budgetsBySignature.set(JSON.stringify(budget), budget);
    }
    if (value.transcript_tool_call_diagnostic_summary && typeof value.transcript_tool_call_diagnostic_summary === 'object') {
      diagnosticSummaryCount += 1;
    }
    if (
      value.transcript_tool_call_diagnostics &&
      typeof value.transcript_tool_call_diagnostics === 'object' &&
      Array.isArray(value.transcript_tool_call_diagnostics.records)
    ) {
      diagnosticRecordCount += value.transcript_tool_call_diagnostics.records.length;
    }
    for (const item of Object.values(value)) {
      visit(item);
    }
  }

  for (const result of probeResults) {
    visit(result.json);
  }

  const scanBudgets = Array.from(budgetsBySignature.values());
  return {
    engaged: scanBudgets.length > 0 || diagnosticSummaryCount > 0 || diagnosticRecordCount > 0,
    scan_budget_count: scanBudgets.length,
    scan_budgets: scanBudgets.slice(0, 10),
    transcript_tool_call_diagnostic_summary_count: diagnosticSummaryCount,
    transcript_tool_call_diagnostic_record_count: diagnosticRecordCount
  };
}

function summarize(options, probeResults, writerStats, seedInfo) {
  const endpoints = {
    '/api/v1/state': summarizeEndpoint('/api/v1/state', probeResults),
    '/api/v1/diagnostics': summarizeEndpoint('/api/v1/diagnostics', probeResults)
  };
  const successes = probeResults.filter((result) => result.ok);
  const failures = probeResults.filter((result) => !result.ok);
  const timeouts = failures.filter((result) => result.error === 'timeout');
  const latencies = successes.map((result) => result.durationMs);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const max = latencies.length > 0 ? Math.max(...latencies) : null;
  const controlPlaneSummaries = extractControlPlaneSummaries(probeResults);
  const queueLatency = extractQueueDelayMetrics(controlPlaneSummaries);
  const scannerEvidence = extractScannerEvidence(probeResults);
  const thresholdFailures = [];
  if (successes.length === 0) {
    thresholdFailures.push('no_successful_probes');
  }
  if (timeouts.length > options.maxTimeouts) {
    thresholdFailures.push('probe_timeouts_exceeded');
  }
  if (p95 !== null && p95 > options.maxP95Ms) {
    thresholdFailures.push('p95_latency_exceeded');
  }
  if (p99 !== null && p99 > options.maxP99Ms) {
    thresholdFailures.push('p99_latency_exceeded');
  }
  if (queueLatency.max_ms !== null && queueLatency.max_ms > options.maxQueueDelayMs) {
    thresholdFailures.push('queue_latency_exceeded');
  }
  if (options.requireScannerEngagement && !scannerEvidence.engaged) {
    thresholdFailures.push('scanner_engagement_missing');
  }
  const passed =
    thresholdFailures.length === 0 &&
    endpoints['/api/v1/state'].successes > 0 &&
    endpoints['/api/v1/diagnostics'].successes > 0;

  return {
    passed,
    mode: seedInfo.mode,
    api_url: options.apiUrl,
    diagnostics_url: options.diagnosticsUrl,
    codex_home: options.codexHome,
    active_transcript: seedInfo.activePath,
    server: {
      pid: options.serverPid,
      port: readPort(options.apiUrl)
    },
    thresholds: {
      max_p95_ms: options.maxP95Ms,
      max_p99_ms: options.maxP99Ms,
      max_queue_delay_ms: options.maxQueueDelayMs,
      max_timeouts: options.maxTimeouts
    },
    threshold_failures: thresholdFailures,
    corpus: seedInfo.corpus,
    probes: {
      total: probeResults.length,
      successes: successes.length,
      failures: failures.length,
      timeouts: timeouts.length,
      failure_errors: countBy(failures.map((result) => result.error ?? `http_${result.status ?? 'unknown'}`)),
      status_counts: countBy(probeResults.map((result) => String(result.status ?? result.error ?? 'unknown'))),
      p50_ms: percentile(latencies, 50),
      p95_ms: p95,
      p99_ms: p99,
      max_ms: max
    },
    endpoints,
    queue_latency: queueLatency,
    scanner_evidence: scannerEvidence,
    transcript_writer: writerStats
  };
}

function readPort(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.port) {
      return Number(parsed.port);
    }
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function printHumanSummary(summary) {
  console.log(`control-plane stress ${summary.passed ? 'PASS' : 'FAIL'}`);
  console.log(`api_url=${summary.api_url}`);
  console.log(`codex_home=${summary.codex_home}`);
  console.log(`active_transcript=${summary.active_transcript}`);
  console.log(
    `probes total=${summary.probes.total} ok=${summary.probes.successes} failures=${summary.probes.failures} timeouts=${summary.probes.timeouts}`
  );
  for (const [endpoint, probes] of Object.entries(summary.endpoints)) {
    console.log(
      `${endpoint} total=${probes.total} ok=${probes.successes} failures=${probes.failures} timeouts=${probes.timeouts} bytes_max=${formatMetric(
        probes.response_bytes.max
      )}`
    );
  }
  if (summary.probes.failures > 0) {
    console.log(`failure_errors=${JSON.stringify(summary.probes.failure_errors)}`);
    console.log(`status_counts=${JSON.stringify(summary.probes.status_counts)}`);
  }
  console.log(
    `latency_ms p50=${formatMetric(summary.probes.p50_ms)} p95=${formatMetric(summary.probes.p95_ms)} p99=${formatMetric(
      summary.probes.p99_ms
    )} max=${formatMetric(summary.probes.max_ms)}`
  );
  console.log(
    `thresholds max_p95=${summary.thresholds.max_p95_ms} max_p99=${summary.thresholds.max_p99_ms} max_timeouts=${summary.thresholds.max_timeouts}`
  );
  console.log(
    `queue_latency_ms max=${formatMetric(summary.queue_latency.max_ms)} p95=${formatMetric(
      summary.queue_latency.p95_ms
    )} threshold=${summary.thresholds.max_queue_delay_ms}`
  );
  console.log(
    `scanner_evidence engaged=${summary.scanner_evidence.engaged} scan_budgets=${summary.scanner_evidence.scan_budget_count} diagnostic_summaries=${summary.scanner_evidence.transcript_tool_call_diagnostic_summary_count}`
  );
  console.log(
    `writer appended_records=${summary.transcript_writer.appended_records} terminal_written=${summary.transcript_writer.terminal_written}`
  );
  if (summary.artifact_path) {
    console.log(`artifact=${summary.artifact_path}`);
  }
  if (summary.threshold_failures.length > 0) {
    console.log(`threshold_failures=${summary.threshold_failures.join(',')}`);
  }
}

function formatMetric(value) {
  return value === null ? 'n/a' : Number(value).toFixed(1);
}

function artifactPathFor(options, summary) {
  if (!options.artifactDir) {
    return null;
  }
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = options.artifactName || `control-plane-stress-${summary.mode}-${safeTimestamp}.json`;
  return path.join(options.artifactDir, filename);
}

function writeArtifact(options, summary) {
  const artifactPath = artifactPathFor(options, summary);
  if (!artifactPath) {
    return null;
  }
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const payload = {
    ...summary,
    artifact_path: artifactPath,
    generated_at: new Date().toISOString()
  };
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return artifactPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const seedInfo = writeSeedCorpus(options);
  const writer = startTranscriptWriter(options, seedInfo.activePath);
  let summary;
  try {
    const results = await runProbes(options);
    writer.stop();
    summary = summarize(options, results, writer.stats(), seedInfo);
  } finally {
    writer.stop();
  }
  const artifactPath = writeArtifact(options, summary);
  if (artifactPath) {
    summary.artifact_path = artifactPath;
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHumanSummary(summary);
  }

  if (!options.keepCorpus && options.codexHome.includes('symphony-stress-codex-')) {
    fs.rmSync(options.codexHome, { recursive: true, force: true });
  }

  process.exit(summary.passed ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
