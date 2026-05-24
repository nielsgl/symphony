#!/usr/bin/env node

const DEFAULT_HOST = process.env.SYMPHONY_HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.SYMPHONY_PORT || '3030';

function usage() {
  return [
    'Usage: node scripts/drain-mode-control.js <status|enter|exit|wait|shutdown> [options]',
    '',
    'Options:',
    '  --url <url>              Base local API URL, default http://127.0.0.1:3030',
    '  --timeout-ms <number>    Wait timeout in milliseconds',
    '  --reason <text>          Operator reason for enter, exit, or shutdown',
    '  --override              Request non-default shutdown override while blocked'
  ].join('\n');
}

function readFlagValue(argv, flag) {
  const equalsPrefix = `${flag}=`;
  const equalsForm = argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsForm) {
    return equalsForm.slice(equalsPrefix.length);
  }

  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function parseTimeoutMs(argv) {
  const raw = readFlagValue(argv, '--timeout-ms');
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('--timeout-ms must be a non-negative integer');
  }
  return value;
}

function baseUrl(argv) {
  const raw = readFlagValue(argv, '--url') || process.env.SYMPHONY_API_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  return raw.replace(/\/+$/, '');
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  return { response, payload };
}

function buildRequest(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!['status', 'enter', 'exit', 'wait', 'shutdown'].includes(command)) {
    throw new Error('invalid_command');
  }

  const apiUrl = baseUrl(argv);
  const timeoutMs = parseTimeoutMs(argv);
  const reason = readFlagValue(argv, '--reason');
  const override = argv.includes('--override');

  if (command === 'status') {
    return {
      method: 'GET',
      url: `${apiUrl}/api/v1/drain-mode`,
      body: null
    };
  }

  const endpoint = {
    enter: '/api/v1/drain-mode/enter',
    exit: '/api/v1/drain-mode/exit',
    wait: '/api/v1/drain-mode/wait',
    shutdown: '/api/v1/drain-mode/shutdown'
  }[command];
  const body = {
    ...(command === 'wait' && timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    ...(['enter', 'exit', 'shutdown'].includes(command) && reason !== undefined ? { reason } : {}),
    ...(command === 'shutdown' && override ? { override: true } : {})
  };
  return {
    method: 'POST',
    url: `${apiUrl}${endpoint}`,
    body
  };
}

async function main(argv = process.argv.slice(2)) {
  let request;
  try {
    request = buildRequest(argv);
  } catch (error) {
    if (error instanceof Error && error.message !== 'invalid_command') {
      throw error;
    }
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const { response, payload } =
    request.method === 'GET' ? await getJson(request.url) : await postJson(request.url, request.body);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return response.ok ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  buildRequest,
  main
};
