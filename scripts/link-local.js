#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const BUILD_VERIFIED_ENV = 'SYMPHONY_LINK_LOCAL_BUILD_VERIFIED';

function renderHelp() {
  return [
    'Symphony local checkout linking',
    '',
    'Usage:',
    '  symphony link-local [--target <path>]',
    '  npm run link:local -- [--target <path>]',
    '',
    'The default target is ~/.local/bin/symphony.'
  ].join('\n');
}

function normalizeArgv(argv) {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

function readFlagValue(argv, flag) {
  const equalsPrefix = `${flag}=`;
  const equalsForm = argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsForm !== undefined) {
    const value = equalsForm.slice(equalsPrefix.length);
    return value ? { present: true, value } : { present: true, missingValue: true };
  }

  const index = argv.findIndex((arg) => arg === flag);
  if (index === -1) {
    return { present: false };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    return { present: true, missingValue: true };
  }

  return { present: true, value };
}

function validateArgv(argv, stderr = process.stderr) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return null;
  }

  const unknownFlag = argv.find(
    (arg) => arg.startsWith('-') && arg !== '--target' && !arg.startsWith('--target=')
  );
  if (unknownFlag) {
    stderr.write(`Unsupported link-local option: ${unknownFlag}\n\n${renderHelp()}\n`);
    return 1;
  }

  const targetFlag = readFlagValue(argv, '--target');
  if (targetFlag.present && targetFlag.missingValue) {
    stderr.write(`Option \`--target\` requires a value.\n\n${renderHelp()}\n`);
    return 1;
  }

  return null;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: 'inherit',
    ...options
  });
}

function statusCode(result) {
  if (result.status !== null) {
    return result.status;
  }

  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
  }
  return 1;
}

function main(argv = process.argv.slice(2)) {
  const normalizedArgv = normalizeArgv(argv);
  const validationExit = validateArgv(normalizedArgv);
  if (validationExit !== null) {
    return validationExit;
  }

  const build = run('npm', ['run', 'build']);
  if (build.status !== 0) {
    return statusCode(build);
  }

  const symphonyScript = path.join(__dirname, 'symphony.js');
  const link = run(process.execPath, [symphonyScript, 'link-local', ...normalizedArgv], {
    env: {
      ...process.env,
      [BUILD_VERIFIED_ENV]: '1'
    }
  });
  return statusCode(link);
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  validateArgv
};
