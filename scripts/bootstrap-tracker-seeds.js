#!/usr/bin/env node

const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

function printUsage() {
  process.stdout.write(
    [
      'Usage: node scripts/bootstrap-tracker-seeds.js --tracker <linear|github> --input <path> [--output <path>] [--strict]',
      '',
      'Options:',
      '  --tracker   Required. Target tracker format: linear or github',
      '  --input     Required. Path to source seed JSON file',
      '  --output    Optional. Write converted payload to this file (otherwise stdout)',
      '  --strict    Optional. Exit nonzero when validation errors are found'
    ].join('\n') + '\n'
  );
}

function parseArgs(argv) {
  const args = {
    tracker: undefined,
    input: undefined,
    output: undefined,
    strict: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--strict') {
      args.strict = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token.startsWith('--tracker=')) {
      args.tracker = token.slice('--tracker='.length);
      continue;
    }

    if (token === '--tracker') {
      args.tracker = argv[i + 1];
      i += 1;
      continue;
    }

    if (token.startsWith('--input=')) {
      args.input = token.slice('--input='.length);
      continue;
    }

    if (token === '--input') {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }

    if (token.startsWith('--output=')) {
      args.output = token.slice('--output='.length);
      continue;
    }

    if (token === '--output') {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
}

function readJsonFile(text, sourcePath) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`seed file must contain a top-level array: ${sourcePath}`);
  }

  return parsed;
}

function validateString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function convertLinear(items) {
  const diagnostics = [];

  const issues = items.map((item, index) => {
    const location = `item[${index}]`;
    const issue = {
      identifier: validateString(item.identifier) ? item.identifier.trim() : '',
      title: validateString(item.title) ? item.title.trim() : '',
      description: validateString(item.description) ? item.description.trim() : '',
      state: validateString(item.state) ? item.state.trim() : 'Todo',
      priority: Number.isInteger(item.priority) ? item.priority : null,
      labels: Array.isArray(item.labels) ? item.labels.filter((label) => validateString(label)).map((label) => label.trim()) : []
    };

    if (!issue.identifier) diagnostics.push(`${location}: missing identifier`);
    if (!issue.title) diagnostics.push(`${location}: missing title`);
    if (!issue.description) diagnostics.push(`${location}: missing description`);
    if (!issue.state) diagnostics.push(`${location}: missing state`);

    return issue;
  });

  return {
    tracker: 'linear',
    summary: {
      total: issues.length,
      valid: issues.length - diagnostics.length,
      errors: diagnostics.length
    },
    diagnostics,
    issues
  };
}

function convertGitHub(items) {
  const diagnostics = [];

  const issues = items.map((item, index) => {
    const location = `item[${index}]`;
    const issue = {
      identifier: validateString(item.identifier) ? item.identifier.trim() : '',
      title: validateString(item.title) ? item.title.trim() : '',
      body: validateString(item.body) ? item.body.trim() : '',
      state: validateString(item.state) ? item.state.trim() : 'Open',
      labels: Array.isArray(item.labels) ? item.labels.filter((label) => validateString(label)).map((label) => label.trim()) : []
    };

    if (!issue.identifier) diagnostics.push(`${location}: missing identifier`);
    if (!issue.title) diagnostics.push(`${location}: missing title`);
    if (!issue.body) diagnostics.push(`${location}: missing body`);
    if (!issue.state) diagnostics.push(`${location}: missing state`);

    return issue;
  });

  return {
    tracker: 'github',
    summary: {
      total: issues.length,
      valid: issues.length - diagnostics.length,
      errors: diagnostics.length
    },
    diagnostics,
    issues
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (args.tracker !== 'linear' && args.tracker !== 'github') {
    process.stderr.write('Error: --tracker must be one of linear or github\n');
    printUsage();
    process.exit(1);
  }

  if (!args.input) {
    process.stderr.write('Error: --input is required\n');
    printUsage();
    process.exit(1);
  }

  const absoluteInputPath = path.resolve(process.cwd(), args.input);
  const raw = await readFile(absoluteInputPath, 'utf8');
  const sourceItems = readJsonFile(raw, absoluteInputPath);

  const converted = args.tracker === 'linear' ? convertLinear(sourceItems) : convertGitHub(sourceItems);
  const outputText = `${JSON.stringify(converted, null, 2)}\n`;

  if (args.strict && converted.diagnostics.length > 0) {
    process.stderr.write(`Validation failed: ${converted.diagnostics.length} error(s)\n`);
    process.stderr.write(`${converted.diagnostics.join('\n')}\n`);
    process.exit(1);
  }

  if (args.output) {
    const absoluteOutputPath = path.resolve(process.cwd(), args.output);
    await writeFile(absoluteOutputPath, outputText, 'utf8');
    process.stdout.write(`Wrote ${converted.tracker} payload to ${absoluteOutputPath}\n`);
    process.exit(0);
  }

  process.stdout.write(outputText);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
