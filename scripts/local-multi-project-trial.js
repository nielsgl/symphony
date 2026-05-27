#!/usr/bin/env node

const { parseArgs, renderHelp, runTrial } = require('./lib/local-multi-project-trial');

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${renderHelp()}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${renderHelp()}\n`);
    return 0;
  }

  const { report, reportPath } = await runTrial(options);
  process.stdout.write(`Local Multi-Project Trial report: ${reportPath}\n`);
  process.stdout.write(`Status: ${report.summary.status}\n`);
  for (const lane of report.lanes) {
    process.stdout.write(`- ${lane.id}: ${lane.status}\n`);
  }
  return report.summary.status === 'failed' || report.summary.status === 'blocked' ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exit(1);
    });
}

module.exports = { main };
