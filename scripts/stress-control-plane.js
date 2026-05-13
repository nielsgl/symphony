#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const DEFAULTS = {
  apiUrl: 'http://127.0.0.1:61026/api/v1/state',
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
  maxTimeouts: 0
};

function usage() {
  return `Usage:
  node scripts/stress-control-plane.js [options]

Required for realistic transcript churn:
  --codex-home <path>             Codex home used by the running Symphony process.

Common options:
  --api-url <url>                 State endpoint to probe. Default: ${DEFAULTS.apiUrl}
  --duration-ms <number>          Total run duration. Default: ${DEFAULTS.durationMs}
  --probe-interval-ms <number>    Delay between /state probes. Default: ${DEFAULTS.probeIntervalMs}
  --probe-timeout-ms <number>     Per-probe timeout. Default: ${DEFAULTS.probeTimeoutMs}
  --corpus-files <number>         Synthetic historical JSONL files. Default: ${DEFAULTS.corpusFiles}
  --seed-records-per-file <n>     Records per historical file. Default: ${DEFAULTS.seedRecordsPerFile}
  --append-interval-ms <number>   Delay between active transcript appends. Default: ${DEFAULTS.appendIntervalMs}
  --append-batch-lines <number>   Lines appended per batch. Default: ${DEFAULTS.appendBatchLines}
  --append-payload-bytes <number> Bytes per appended record payload. Default: ${DEFAULTS.appendPayloadBytes}
  --thread-id <id>                Active thread id for the hot transcript. Default: stress-thread
  --turn-id <id>                  Active turn id for the hot transcript. Default: stress-turn
  --session-id <id>               Active session id for the hot transcript. Default: <thread-id>-<turn-id>
  --append-terminal               Append a task_complete sentinel near the end.
  --max-p95-ms <number>           Fail if p95 exceeds this. Default: ${DEFAULTS.maxP95Ms}
  --max-p99-ms <number>           Fail if p99 exceeds this. Default: ${DEFAULTS.maxP99Ms}
  --max-timeouts <number>         Fail if timeout count exceeds this. Default: ${DEFAULTS.maxTimeouts}
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
      case '--max-timeouts':
        options.maxTimeouts = readNumber();
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
  if (!options.codexHome) {
    options.codexHome = path.join(os.tmpdir(), `symphony-stress-codex-${process.pid}`);
  }
  return options;
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
  const sessionsDir = path.join(options.codexHome, 'sessions', '2026', '05', '13');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filler = 'x'.repeat(Math.max(0, options.appendPayloadBytes));

  for (let fileIndex = 0; fileIndex < options.corpusFiles; fileIndex += 1) {
    const threadId = `historical-thread-${String(fileIndex).padStart(5, '0')}`;
    const filePath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);
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
  }

  const activePath = path.join(sessionsDir, `rollout-${options.threadId}.jsonl`);
  fs.writeFileSync(
    activePath,
    makeRecord({ type: 'session_meta', id: options.threadId, thread_id: options.threadId, session_id: options.sessionId }),
    'utf8'
  );
  return { sessionsDir, activePath };
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

async function probeState(apiUrl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(apiUrl, { signal: controller.signal });
    const text = await response.text();
    const durationMs = performance.now() - startedAt;
    return { ok: response.ok, status: response.status, durationMs, bytes: Buffer.byteLength(text), error: null };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    return {
      ok: false,
      status: null,
      durationMs,
      bytes: 0,
      error: error && error.name === 'AbortError' ? 'timeout' : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runProbes(options) {
  const deadline = performance.now() + options.durationMs;
  const results = [];
  while (performance.now() < deadline) {
    results.push(await probeState(options.apiUrl, options.probeTimeoutMs));
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.probeIntervalMs, remaining)));
  }
  return results;
}

function summarize(options, probeResults, writerStats, activePath) {
  const successes = probeResults.filter((result) => result.ok);
  const failures = probeResults.filter((result) => !result.ok);
  const timeouts = failures.filter((result) => result.error === 'timeout');
  const failureErrors = countBy(failures.map((result) => result.error ?? `http_${result.status ?? 'unknown'}`));
  const statusCounts = countBy(probeResults.map((result) => String(result.status ?? result.error ?? 'unknown')));
  const latencies = successes.map((result) => result.durationMs);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const max = latencies.length > 0 ? Math.max(...latencies) : null;
  const passed =
    successes.length > 0 &&
    timeouts.length <= options.maxTimeouts &&
    (p95 === null || p95 <= options.maxP95Ms) &&
    (p99 === null || p99 <= options.maxP99Ms);

  return {
    passed,
    api_url: options.apiUrl,
    codex_home: options.codexHome,
    active_transcript: activePath,
    thresholds: {
      max_p95_ms: options.maxP95Ms,
      max_p99_ms: options.maxP99Ms,
      max_timeouts: options.maxTimeouts
    },
    probes: {
      total: probeResults.length,
      successes: successes.length,
      failures: failures.length,
      timeouts: timeouts.length,
      failure_errors: failureErrors,
      status_counts: statusCounts,
      p50_ms: percentile(latencies, 50),
      p95_ms: p95,
      p99_ms: p99,
      max_ms: max
    },
    transcript_writer: writerStats
  };
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
    `writer appended_records=${summary.transcript_writer.appended_records} terminal_written=${summary.transcript_writer.terminal_written}`
  );
}

function formatMetric(value) {
  return value === null ? 'n/a' : value.toFixed(1);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { activePath } = writeSeedCorpus(options);
  const writer = startTranscriptWriter(options, activePath);
  let summary;
  try {
    const results = await runProbes(options);
    writer.stop();
    summary = summarize(options, results, writer.stats(), activePath);
  } finally {
    writer.stop();
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
