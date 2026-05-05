#!/usr/bin/env node

const { readFile } = require('node:fs/promises');
const path = require('node:path');

const ERROR_CODE = 'hygiene_backlog_report_generation_failed';
const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_STALE_DAYS = 30;
const DEFAULT_STATUSES = ['Backlog', 'Todo'];

function usage() {
  process.stdout.write(
    [
      'Usage: node scripts/backlog-hygiene-report.js [options]',
      '',
      'Options:',
      '  --format <json|table>       Output format (default: table)',
      '  --project-slug <slug>       Linear project slug (or env LINEAR_PROJECT_SLUG)',
      '  --team-key <key>            Optional team key filter',
      '  --stale-days <days>         Stale threshold in days (default: 30)',
      '  --now <iso-date>            Deterministic clock override for reports/tests',
      '  --input <path>              Read issue JSON array instead of calling Linear',
      '  --help                      Show this help message',
      '',
      'Required environment unless --input is used:',
      '  LINEAR_API_KEY',
      '',
      'Optional environment:',
      `  LINEAR_ENDPOINT (default: ${DEFAULT_ENDPOINT})`,
      '  LINEAR_PROJECT_SLUG',
      '  LINEAR_TEAM_KEY'
    ].join('\n') + '\n'
  );
}

function parseArgs(argv) {
  const args = {
    format: 'table',
    projectSlug: process.env.LINEAR_PROJECT_SLUG,
    teamKey: process.env.LINEAR_TEAM_KEY,
    staleDays: DEFAULT_STALE_DAYS,
    now: process.env.SYMPHONY_BACKLOG_HYGIENE_NOW,
    input: null,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token.startsWith('--format=')) {
      args.format = token.slice('--format='.length);
      continue;
    }
    if (token === '--format') {
      args.format = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--project-slug=')) {
      args.projectSlug = token.slice('--project-slug='.length);
      continue;
    }
    if (token === '--project-slug') {
      args.projectSlug = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--team-key=')) {
      args.teamKey = token.slice('--team-key='.length);
      continue;
    }
    if (token === '--team-key') {
      args.teamKey = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--stale-days=')) {
      args.staleDays = Number(token.slice('--stale-days='.length));
      continue;
    }
    if (token === '--stale-days') {
      args.staleDays = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith('--now=')) {
      args.now = token.slice('--now='.length);
      continue;
    }
    if (token === '--now') {
      args.now = argv[i + 1];
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
    }
  }

  return args;
}

function mustString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseClock(value) {
  const parsed = mustString(value) ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid --now date '${value}'`);
  }
  return parsed;
}

function parseIsoDate(value) {
  if (!mustString(value)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readStateName(issue) {
  if (mustString(issue?.status)) {
    return issue.status.trim();
  }
  if (mustString(issue?.state?.name)) {
    return issue.state.name.trim();
  }
  return '';
}

function isTerminalIssue(issue) {
  const archived = Boolean(issue?.archivedAt || issue?.archived_at || issue?.archived);
  const canceled = Boolean(issue?.canceledAt || issue?.canceled_at || issue?.canceled);
  const completed = Boolean(issue?.completedAt || issue?.completed_at || issue?.completed);
  return archived || canceled || completed;
}

function daysSinceUpdate(issue, now) {
  const updatedAt = parseIsoDate(issue?.updatedAt || issue?.updated_at);
  if (!updatedAt) {
    return null;
  }
  const elapsedMs = now.getTime() - updatedAt.getTime();
  return Math.max(0, Math.floor(elapsedMs / 86400000));
}

function normalizePriority(value) {
  return Number.isInteger(value) ? value : null;
}

function recommendedAction(issue, status) {
  const priority = normalizePriority(issue?.priority);
  if (priority === 1 || priority === 2) {
    return 'prioritize';
  }
  if (status.toLowerCase() === 'todo') {
    return 're-scope';
  }
  if (status.toLowerCase() === 'backlog') {
    return 'defer';
  }
  return 'close';
}

function normalizeReportIssue(issue, now) {
  const status = readStateName(issue);
  const days = daysSinceUpdate(issue, now);
  return {
    id: mustString(issue?.identifier) ? issue.identifier.trim() : String(issue?.id || '').trim(),
    title: String(issue?.title || '').trim(),
    status,
    priority: normalizePriority(issue?.priority),
    days_since_update: days,
    recommended_action: recommendedAction(issue, status)
  };
}

function buildStaleReport(issues, options = {}) {
  const now = options.now instanceof Date ? options.now : parseClock(options.now);
  const staleDays = Number.isInteger(options.staleDays) ? options.staleDays : DEFAULT_STALE_DAYS;
  const statuses = new Set((options.statuses || DEFAULT_STATUSES).map((entry) => entry.toLowerCase()));

  return issues
    .filter((issue) => {
      const status = readStateName(issue).toLowerCase();
      const days = daysSinceUpdate(issue, now);
      return statuses.has(status) && days !== null && days >= staleDays && !isTerminalIssue(issue);
    })
    .map((issue) => normalizeReportIssue(issue, now))
    .sort((a, b) => {
      if (b.days_since_update !== a.days_since_update) return b.days_since_update - a.days_since_update;
      return a.id.localeCompare(b.id);
    });
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

function formatTable(report) {
  const columns = [
    ['id', 'ID'],
    ['status', 'Status'],
    ['priority', 'Priority'],
    ['days_since_update', 'Days'],
    ['recommended_action', 'Action'],
    ['title', 'Title']
  ];
  const widths = columns.map(([key, header]) =>
    Math.max(header.length, ...report.map((entry) => String(entry[key] ?? '').length))
  );
  const header = columns.map(([, label], index) => pad(label, widths[index])).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  const rows = report.map((entry) => columns.map(([key], index) => pad(entry[key] ?? '', widths[index])).join('  '));
  return [header, divider, ...rows].join('\n') + '\n';
}

async function readIssuesFromFile(inputPath) {
  const absolutePath = path.resolve(process.cwd(), inputPath);
  const parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`input must contain a top-level issue array: ${absolutePath}`);
  }
  return parsed;
}

async function linearGraphqlRequest(endpoint, apiKey, query, variables) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) {
    throw new Error(`Linear request failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${payload.errors.map((entry) => entry?.message || 'unknown').join('; ')}`);
  }
  return payload?.data;
}

async function fetchBacklogIssues(endpoint, apiKey, projectSlug, teamKey) {
  const query = `
query BacklogHygieneIssues($projectSlug: String!, $teamKey: String, $after: String) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: ["Backlog", "Todo"] } }
      team: { key: { eq: $teamKey } }
    }
    first: 100
    after: $after
  ) {
    nodes {
      id
      identifier
      title
      priority
      updatedAt
      archivedAt
      canceledAt
      completedAt
      state { name }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

  const queryWithoutTeam = query.replace('      team: { key: { eq: $teamKey } }\n', '');
  const selectedQuery = mustString(teamKey) ? query : queryWithoutTeam;
  const variables = mustString(teamKey) ? { projectSlug, teamKey, after: null } : { projectSlug, after: null };
  const issues = [];
  let after = null;

  do {
    variables.after = after;
    const data = await linearGraphqlRequest(endpoint, apiKey, selectedQuery, variables);
    const page = data?.issues;
    const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
    issues.push(...nodes);
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return issues;
}

async function loadIssues(args) {
  if (mustString(args.input)) {
    return readIssuesFromFile(args.input);
  }
  if (!mustString(args.projectSlug)) {
    throw new Error('project slug is required via --project-slug or LINEAR_PROJECT_SLUG');
  }
  const apiKey = process.env.LINEAR_API_KEY;
  if (!mustString(apiKey)) {
    throw new Error('LINEAR_API_KEY is required when --input is not used');
  }
  return fetchBacklogIssues(process.env.LINEAR_ENDPOINT || DEFAULT_ENDPOINT, apiKey, args.projectSlug, args.teamKey);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!['json', 'table'].includes(args.format)) {
    throw new Error(`unsupported --format '${args.format}'. Expected json or table`);
  }
  if (!Number.isInteger(args.staleDays) || args.staleDays < 1) {
    throw new Error('--stale-days must be a positive integer');
  }

  const issues = await loadIssues(args);
  const report = buildStaleReport(issues, { now: args.now, staleDays: args.staleDays });
  process.stdout.write(args.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : formatTable(report));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${ERROR_CODE}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  ERROR_CODE,
  parseArgs,
  buildStaleReport,
  formatTable,
  recommendedAction
};
