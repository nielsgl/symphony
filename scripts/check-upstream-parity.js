#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const HIGH_IMPACT = new Set(['spec_required', 'behavioral_risk']);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(targetPath) {
  return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
}

function writeFileAtomic(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
}

function normalizeRepoSlug(repo) {
  return String(repo)
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .trim();
}

function runGit(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function resolveHeadSha(config) {
  const remote = `${config.upstream_repo.replace(/\.git$/, '')}.git`;
  const branchRef = `refs/heads/${config.upstream_branch}`;
  const result = runGit(['ls-remote', remote, branchRef]);
  if (result.status !== 0) {
    throw new Error(`Unable to resolve upstream HEAD via git ls-remote: ${result.stderr || result.stdout}`);
  }

  const line = result.stdout.split(/\r?\n/).find(Boolean);
  const sha = line ? line.split(/\s+/)[0] : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Invalid upstream HEAD SHA from ls-remote output: ${line || '<empty>'}`);
  }

  return sha;
}

function readFixtureCompare(fixturePath) {
  const fixture = readJson(fixturePath);
  if (!fixture || typeof fixture !== 'object' || !Array.isArray(fixture.files)) {
    throw new Error('Fixture compare payload must be an object with a files[] array.');
  }
  return fixture;
}

function githubRequest(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'symphony-upstream-parity-check',
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`GitHub API request failed (${res.statusCode}): ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`GitHub API response parse failed: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR__/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesWatchlist(filePath, watchlist) {
  return watchlist.some((entry) => {
    const pathMatch = globToRegExp(entry.path_glob).test(filePath);
    if (!pathMatch) {
      return false;
    }
    if (!Array.isArray(entry.hunk_regex) || entry.hunk_regex.length === 0) {
      return true;
    }

    const patch = String(entry.patch || '');
    return entry.hunk_regex.some((expr) => new RegExp(expr, 'i').test(patch));
  });
}

function classifyDelta(filePath, patch) {
  const text = String(patch || '');
  const lower = text.toLowerCase();
  const normative = /\b(must|shall|required|never|always|forbidden|default)\b/i.test(text);
  const semanticSignal = /\b(retry|state|dispatch|token|approval|timeout|validation|security|workspace|orchestrator|tracker|api|runner|event)\b/i.test(
    lower
  );

  if (filePath === 'SPEC.md') {
    return normative || semanticSignal ? 'spec_required' : 'docs_only';
  }

  if (filePath === 'elixir/WORKFLOW.md') {
    return semanticSignal ? 'spec_required' : 'docs_only';
  }

  if (filePath.startsWith('elixir/test/')) {
    return 'behavioral_risk';
  }

  if (filePath.startsWith('elixir/lib/')) {
    return semanticSignal ? 'behavioral_risk' : 'docs_only';
  }

  return 'no_impact';
}

function mapOwner(filePath, ownership) {
  for (const entry of ownership) {
    if (globToRegExp(entry.path_glob).test(filePath)) {
      return entry.owner;
    }
  }
  return 'docs/parity';
}

function parseBaselineSha(config) {
  const sha = String(config.last_reviewed_sha || '').trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('Config last_reviewed_sha must be a 40-character lowercase hex SHA.');
  }
  return sha;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Upstream Delta Report');
  lines.push('');
  lines.push(`- Upstream: \`${report.upstream.repo}\` @ \`${report.upstream.branch}\``);
  lines.push(`- Baseline: \`${report.baseline.last_reviewed_sha}\``);
  lines.push(`- Current upstream head: \`${report.upstream.head_sha}\``);
  lines.push(`- Generated at: \`${report.generated_at}\``);
  lines.push('');
  lines.push('| File | Classification | Owner | Triaged |');
  lines.push('|---|---|---|---|');
  for (const item of report.deltas) {
    lines.push(`| \`${item.file}\` | \`${item.classification}\` | \`${item.owner}\` | \`${item.triaged ? 'yes' : 'no'}\` |`);
  }
  if (report.deltas.length === 0) {
    lines.push('| _none_ | `no_impact` | `docs/parity` | `yes` |');
  }
  lines.push('');
  lines.push(`High-impact untriaged count: **${report.summary.high_impact_untriaged}**`);
  return `${lines.join('\n')}\n`;
}

function createIssueSeeds(deltas) {
  return deltas
    .filter((item) => HIGH_IMPACT.has(item.classification))
    .map((item) => ({
      title: `[Upstream Parity] Triage ${item.classification}: ${item.file}`,
      body: [
        '## Summary',
        `Upstream delta detected in \`${item.file}\` with classification \`${item.classification}\`.`,
        '',
        '## Ownership',
        `- subsystem: \`${item.owner}\``,
        '',
        '## Required Actions',
        '- Review upstream patch intent.',
        '- Confirm local code/tests/docs parity or open implementation ticket.',
        '- Mark triaged outcome in parity report process.'
      ].join('\n')
    }));
}

function parseArgs(argv) {
  const args = {
    config: 'docs/analysis/crossref/upstream-parity.json',
    reportJson: 'docs/analysis/crossref/appendix/upstream-delta-report.json',
    reportMd: 'docs/analysis/crossref/appendix/upstream-delta-report.md',
    mode: process.env.SYMPHONY_UPSTREAM_PARITY_MODE || 'advisory',
    bypass: ['1', 'true', 'yes'].includes(String(process.env.SYMPHONY_UPSTREAM_PARITY_BYPASS || '').toLowerCase()),
    fixture: process.env.SYMPHONY_UPSTREAM_PARITY_FIXTURE || ''
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--config' && next) {
      args.config = next;
      index += 1;
    } else if (token === '--report-json' && next) {
      args.reportJson = next;
      index += 1;
    } else if (token === '--report-md' && next) {
      args.reportMd = next;
      index += 1;
    } else if (token === '--mode' && next) {
      args.mode = next;
      index += 1;
    } else if (token === '--fixture' && next) {
      args.fixture = next;
      index += 1;
    }
  }

  return args;
}

async function run() {
  const args = parseArgs(process.argv);
  const configPath = path.join(process.cwd(), args.config);
  if (!fs.existsSync(configPath)) {
    fail(`Upstream parity check failed: missing config ${args.config}`);
  }

  const config = readJson(configPath);
  const baselineSha = parseBaselineSha(config);
  const headSha = process.env.SYMPHONY_UPSTREAM_PARITY_HEAD_SHA || resolveHeadSha(config);

  const comparePayload = args.fixture
    ? readFixtureCompare(path.join(process.cwd(), args.fixture))
    : await githubRequest(
        `https://api.github.com/repos/${normalizeRepoSlug(config.upstream_repo)}/compare/${baselineSha}...${headSha}`,
        process.env.GITHUB_TOKEN || ''
      );

  const rawFiles = Array.isArray(comparePayload.files) ? comparePayload.files : [];
  const watched = [];
  for (const file of rawFiles) {
    const filePath = String(file.filename || '');
    const patch = String(file.patch || '');
    const watchlist = (config.watchlist || []).map((entry) => ({ ...entry, patch }));
    if (!matchesWatchlist(filePath, watchlist)) {
      continue;
    }

    const classification = classifyDelta(filePath, patch);
    const owner = mapOwner(filePath, config.ownership || []);
    watched.push({
      file: filePath,
      status: file.status || 'modified',
      additions: Number(file.additions || 0),
      deletions: Number(file.deletions || 0),
      patch_excerpt: patch.split(/\r?\n/).slice(0, 20).join('\n'),
      classification,
      owner,
      triaged: false
    });
  }

  watched.sort((left, right) => left.file.localeCompare(right.file));

  const summary = {
    total_watched_deltas: watched.length,
    by_classification: {
      spec_required: watched.filter((entry) => entry.classification === 'spec_required').length,
      behavioral_risk: watched.filter((entry) => entry.classification === 'behavioral_risk').length,
      docs_only: watched.filter((entry) => entry.classification === 'docs_only').length,
      no_impact: watched.filter((entry) => entry.classification === 'no_impact').length
    },
    high_impact_untriaged: watched.filter((entry) => HIGH_IMPACT.has(entry.classification) && !entry.triaged).length
  };

  const report = {
    generated_at: new Date().toISOString(),
    upstream: {
      repo: config.upstream_repo,
      branch: config.upstream_branch,
      head_sha: headSha
    },
    baseline: {
      last_reviewed_sha: baselineSha,
      reviewed_at: config.reviewed_at || null,
      reviewed_by: config.reviewed_by || null
    },
    summary,
    deltas: watched,
    issue_seeds: createIssueSeeds(watched)
  };

  const markdown = renderMarkdown(report);
  writeFileAtomic(path.join(process.cwd(), args.reportJson), `${JSON.stringify(report, null, 2)}\n`);
  writeFileAtomic(path.join(process.cwd(), args.reportMd), markdown);
  process.stdout.write(markdown);

  if (args.bypass) {
    process.stdout.write('Upstream parity blocking bypass enabled via SYMPHONY_UPSTREAM_PARITY_BYPASS.\n');
    return;
  }

  const blocking = String(args.mode).toLowerCase() === 'blocking';
  if (blocking && summary.high_impact_untriaged > 0) {
    fail(
      `Upstream parity check failed: ${summary.high_impact_untriaged} high-impact delta(s) are untriaged. ` +
        'Set SYMPHONY_UPSTREAM_PARITY_BYPASS=1 for explicit local bypass.'
    );
  }
}

module.exports = {
  classifyDelta,
  matchesWatchlist,
  parseBaselineSha,
  globToRegExp,
  mapOwner
};

if (require.main === module) {
  run().catch((error) => {
    fail(`Upstream parity check failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
