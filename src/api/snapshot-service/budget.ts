import type { ApiBudgetProjection } from '../types';

export function defaultBudgetProjection(windowMinutes = 1440): ApiBudgetProjection {
  return {
    budget_usage_tokens: null,
    budget_limit_tokens: null,
    budget_window_minutes: windowMinutes,
    budget_status: 'ok' as const,
    budget_policy: null,
    budget_message: null
  };
}

export function projectBudget(entry: { budget?: ApiBudgetProjection | null }): ApiBudgetProjection {
  return entry.budget ? { ...entry.budget } : defaultBudgetProjection();
}
