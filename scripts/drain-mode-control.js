#!/usr/bin/env node

const DEFAULT_HOST = process.env.SYMPHONY_HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.SYMPHONY_PORT || '3030';

function usage() {
  return [
    'Usage: node scripts/drain-mode-control.js <wait|shutdown> [options]',
    '',
    'Options:',
    '  --url <url>              Base local API URL, default http://127.0.0.1:3030',
    '  --timeout-ms <number>    Wait timeout in milliseconds',
    '  --reason <text>          Operator reason for shutdown',
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

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command !== 'wait' && command !== 'shutdown') {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const apiUrl = baseUrl(argv);
  const timeoutMs = parseTimeoutMs(argv);
  const reason = readFlagValue(argv, '--reason');
  const override = argv.includes('--override');

  const body = {
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
    ...(reason === undefined ? {} : { reason }),
    ...(override ? { override: true } : {})
  };

  const endpoint = command === 'wait' ? '/api/v1/drain-mode/wait' : '/api/v1/drain-mode/shutdown';
  const { response, payload } = await postJson(`${apiUrl}${endpoint}`, body);
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
  main
};
