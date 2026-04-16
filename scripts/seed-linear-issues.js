#!/usr/bin/env node

const { readFile } = require('node:fs/promises');
const path = require('node:path');

function usage() {
  process.stdout.write(
    [
      'Usage: node scripts/seed-linear-issues.js [options]',
      '',
      'Options:',
      '  --input <path>           Seed JSON path (default: tests/fixtures/tracker-seeds/linear-todo-issues.json)',
      '  --project-slug <slug>    Linear project slug (or env LINEAR_PROJECT_SLUG)',
      '  --team-key <key>         Optional team key when project has multiple teams',
      '  --apply                  Create issues in Linear (default is dry-run)',
      '  --strict                 Exit non-zero on validation errors',
      '  --help                   Show this help message',
      '',
      'Required environment:',
      '  LINEAR_API_KEY',
      '',
      'Optional environment:',
      '  LINEAR_ENDPOINT (default: https://api.linear.app/graphql)',
      '  LINEAR_PROJECT_SLUG',
      '  LINEAR_TEAM_KEY'
    ].join('\n') + '\n'
  );
}

function parseArgs(argv) {
  const args = {
    input: 'tests/fixtures/tracker-seeds/linear-todo-issues.json',
    projectSlug: process.env.LINEAR_PROJECT_SLUG,
    teamKey: process.env.LINEAR_TEAM_KEY,
    apply: false,
    strict: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--apply') {
      args.apply = true;
      continue;
    }

    if (token === '--strict') {
      args.strict = true;
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
  }

  return args;
}

function mustString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function readSeedFile(inputPath) {
  const absolutePath = path.resolve(process.cwd(), inputPath);
  const text = await readFile(absolutePath, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`seed file must contain a top-level array: ${absolutePath}`);
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
    const message = payload.errors.map((entry) => entry?.message || 'unknown GraphQL error').join('; ');
    throw new Error(`Linear GraphQL errors: ${message}`);
  }

  return payload?.data;
}

async function resolveProjectAndTeam(endpoint, apiKey, projectSlug, teamKey) {
  const query = `
query ResolveProject($projectSlug: String!) {
  projects(filter: { slugId: { eq: $projectSlug } }, first: 1) {
    nodes {
      id
      slugId
      name
      teams {
        nodes {
          id
          key
          name
          states {
            nodes {
              id
              name
            }
          }
        }
      }
    }
  }
}`;

  const data = await linearGraphqlRequest(endpoint, apiKey, query, { projectSlug });
  const project = data?.projects?.nodes?.[0];
  if (!project) {
    throw new Error(`no Linear project found for slug '${projectSlug}'`);
  }

  const teams = Array.isArray(project?.teams?.nodes) ? project.teams.nodes : [];
  if (teams.length === 0) {
    throw new Error(`project '${projectSlug}' has no teams`);
  }

  let team = teams[0];
  if (mustString(teamKey)) {
    const matched = teams.find((entry) => String(entry.key || '').toLowerCase() === String(teamKey).toLowerCase());
    if (!matched) {
      throw new Error(`team key '${teamKey}' not found in project '${projectSlug}'`);
    }
    team = matched;
  }

  const states = Array.isArray(team?.states?.nodes) ? team.states.nodes : [];
  if (states.length === 0) {
    throw new Error(`team '${team.key || team.id}' has no states`);
  }

  return {
    projectId: project.id,
    projectSlug: project.slugId,
    teamId: team.id,
    teamKey: team.key,
    states
  };
}

function stateIdByName(states, stateName) {
  const normalized = String(stateName || '').trim().toLowerCase();
  const matched = states.find((entry) => String(entry?.name || '').trim().toLowerCase() === normalized);
  return matched?.id || null;
}

function buildIssueInput(seedItem, context, stateId) {
  const title = String(seedItem.title || '').trim();
  const description = String(seedItem.description || '').trim();

  const input = {
    teamId: context.teamId,
    projectId: context.projectId,
    stateId,
    title,
    description
  };

  if (Number.isInteger(seedItem.priority)) {
    input.priority = seedItem.priority;
  }

  return input;
}

async function createLinearIssue(endpoint, apiKey, input) {
  const mutation = `
mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      url
    }
  }
}`;

  const data = await linearGraphqlRequest(endpoint, apiKey, mutation, { input });
  const result = data?.issueCreate;
  if (!result?.success || !result?.issue) {
    throw new Error('issueCreate did not return a successful issue payload');
  }

  return result.issue;
}

function validateSeedItem(item, index) {
  const errors = [];
  if (!mustString(item.identifier)) errors.push(`item[${index}] missing identifier`);
  if (!mustString(item.title)) errors.push(`item[${index}] missing title`);
  if (!mustString(item.description)) errors.push(`item[${index}] missing description`);
  if (!mustString(item.state)) errors.push(`item[${index}] missing state`);
  return errors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  if (!mustString(args.projectSlug)) {
    process.stderr.write('Error: project slug is required via --project-slug or LINEAR_PROJECT_SLUG\n');
    usage();
    process.exit(1);
  }

  const apiKey = process.env.LINEAR_API_KEY;
  if (!mustString(apiKey)) {
    process.stderr.write('Error: LINEAR_API_KEY is required\n');
    process.exit(1);
  }

  const endpoint = process.env.LINEAR_ENDPOINT || 'https://api.linear.app/graphql';

  const seedItems = await readSeedFile(args.input);
  const context = await resolveProjectAndTeam(endpoint, apiKey, args.projectSlug, args.teamKey);

  const diagnostics = [];
  const plan = [];
  const created = [];

  for (let index = 0; index < seedItems.length; index += 1) {
    const item = seedItems[index];
    diagnostics.push(...validateSeedItem(item, index));

    const stateId = stateIdByName(context.states, item.state);
    if (!stateId) {
      diagnostics.push(`item[${index}] state '${item.state}' not found on team '${context.teamKey || context.teamId}'`);
      continue;
    }

    const input = buildIssueInput(item, context, stateId);
    plan.push({
      seed_identifier: item.identifier,
      title: input.title,
      state: item.state,
      priority: input.priority ?? null
    });

    if (args.apply) {
      const issue = await createLinearIssue(endpoint, apiKey, input);
      created.push({
        seed_identifier: item.identifier,
        issue_identifier: issue.identifier,
        title: issue.title,
        url: issue.url
      });
    }
  }

  const output = {
    mode: args.apply ? 'apply' : 'dry-run',
    endpoint,
    project_slug: context.projectSlug,
    team_key: context.teamKey || null,
    summary: {
      total_seed_items: seedItems.length,
      planned_items: plan.length,
      created_items: created.length,
      diagnostics: diagnostics.length
    },
    diagnostics,
    plan,
    created
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (args.strict && diagnostics.length > 0) {
    process.exit(1);
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  stateIdByName,
  validateSeedItem,
  buildIssueInput
};
