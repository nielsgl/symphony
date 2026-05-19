import type { BudgetRuntimeProjection, OrchestratorConfig } from '../types';

export type BudgetUsageSample = { at_ms: number; total_tokens: number };

export type BudgetScope = 'per_run_total_tokens' | 'per_issue_rolling_tokens';

export interface BudgetCandidate {
  scope: BudgetScope;
  usage: number;
  limit: number;
  warning_threshold: number;
  status: Exclude<BudgetRuntimeProjection['budget_status'], 'telemetry_unavailable'>;
}

export function defaultBudgetProjection(windowMinutes = 1440): BudgetRuntimeProjection {
  return {
    budget_usage_tokens: null,
    budget_limit_tokens: null,
    budget_window_minutes: windowMinutes,
    budget_status: 'ok',
    budget_policy: null,
    budget_message: null
  };
}

export function budgetConfigured(budget: OrchestratorConfig['budget']): boolean {
  return Boolean(
    budget &&
      (typeof budget.per_run_total_tokens === 'number' || typeof budget.per_issue_rolling_tokens === 'number')
  );
}

export function pruneBudgetSamples(
  budget: OrchestratorConfig['budget'],
  budgetSamples: Map<string, BudgetUsageSample[]>,
  issueId: string,
  nowMs: number
): BudgetUsageSample[] {
  const windowMinutes = budget?.rolling_window_minutes ?? 1440;
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const samples = (budgetSamples.get(issueId) ?? []).filter((sample) => nowMs - sample.at_ms <= windowMs);
  budgetSamples.set(issueId, samples);
  return samples;
}

export function selectBudgetCandidate(params: {
  budget: OrchestratorConfig['budget'];
  samples: BudgetUsageSample[];
  currentAttemptTokens: number;
}): BudgetCandidate | null {
  const budget = params.budget;
  if (!budget) {
    return null;
  }

  const currentUsage = Math.max(0, params.currentAttemptTokens);
  const rollingUsage = params.samples.reduce((sum, sample) => sum + sample.total_tokens, 0) + currentUsage;
  const candidates: BudgetCandidate[] = [];
  const addCandidate = (scope: BudgetScope, usage: number, limit: number) => {
    const warningThreshold = Math.ceil(limit * budget.warning_threshold_ratio);
    candidates.push({
      scope,
      usage,
      limit,
      warning_threshold: warningThreshold,
      status: usage >= limit ? 'hard_limited' : usage >= warningThreshold ? 'warning' : 'ok'
    });
  };
  if (typeof budget.per_run_total_tokens === 'number') {
    addCandidate('per_run_total_tokens', currentUsage, budget.per_run_total_tokens);
  }
  if (typeof budget.per_issue_rolling_tokens === 'number') {
    addCandidate('per_issue_rolling_tokens', rollingUsage, budget.per_issue_rolling_tokens);
  }
  const [selected] = candidates.sort((a, b) => {
    const statusDelta = budgetStatusRank(b.status) - budgetStatusRank(a.status);
    if (statusDelta !== 0) {
      return statusDelta;
    }
    const ratioDelta = b.usage / b.limit - a.usage / a.limit;
    if (ratioDelta !== 0) {
      return ratioDelta;
    }
    return a.scope.localeCompare(b.scope);
  });
  return selected ?? null;
}

export function computeBudgetProjection(params: {
  budget: OrchestratorConfig['budget'];
  selected: BudgetCandidate | null;
  telemetryStatus: 'available' | 'pending' | 'unavailable';
  forcedStatus?: BudgetRuntimeProjection['budget_status'];
  forcedMessage?: string | null;
}): BudgetRuntimeProjection {
  const budget = params.budget;
  if (!budget) {
    return defaultBudgetProjection();
  }

  const isBudgetConfigured = budgetConfigured(budget);
  let status: BudgetRuntimeProjection['budget_status'] = 'ok';
  if (params.forcedStatus) {
    status = params.forcedStatus;
  } else if (isBudgetConfigured && params.telemetryStatus === 'unavailable') {
    status = 'telemetry_unavailable';
  } else if (params.selected) {
    status = params.selected.status;
  }

  return {
    budget_usage_tokens: isBudgetConfigured && params.telemetryStatus !== 'unavailable' ? params.selected?.usage ?? null : null,
    budget_limit_tokens: params.selected?.limit ?? null,
    budget_window_minutes: budget.rolling_window_minutes,
    budget_status: status,
    budget_policy: isBudgetConfigured ? budget.hard_limit_policy : null,
    budget_message: params.forcedMessage ?? null
  };
}

export function recordBudgetUsageSample(params: {
  budget: OrchestratorConfig['budget'];
  samples: BudgetUsageSample[];
  totalTokens: number;
  timestampMs: number;
}): BudgetUsageSample[] {
  if (!budgetConfigured(params.budget) || params.totalTokens <= 0) {
    return params.samples;
  }
  params.samples.push({ at_ms: params.timestampMs, total_tokens: Math.max(0, params.totalTokens) });
  return params.samples;
}

export function budgetScopeLabel(scope: BudgetScope): string {
  return scope === 'per_issue_rolling_tokens' ? 'rolling issue budget' : 'per-run budget';
}

function budgetStatusRank(status: BudgetCandidate['status']): number {
  switch (status) {
    case 'hard_limited':
      return 2;
    case 'warning':
      return 1;
    case 'ok':
      return 0;
  }
}
