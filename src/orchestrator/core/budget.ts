import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import { cloneWorkerTerminationResult } from './snapshot-cloning';
import { isTerminalTurnEvent } from './worker-events';
import type {
  BlockedEntry,
  BudgetRuntimeProjection,
  OrchestratorConfig,
  RunningEntry,
  WorkerObservabilityEvent,
  WorkerTerminationResult
} from '../types';

export type BudgetUsageSample = { at_ms: number; total_tokens: number };

export type BudgetScope = 'per_run_total_tokens' | 'per_issue_rolling_tokens';

export interface BudgetCandidate {
  scope: BudgetScope;
  usage: number;
  limit: number;
  warning_threshold: number;
  status: Exclude<BudgetRuntimeProjection['budget_status'], 'telemetry_unavailable'>;
}

type RuntimeEventRecorder = (params: {
  event: string;
  severity: 'info' | 'warn' | 'error';
  issue_identifier?: string;
  session_id?: string;
  detail?: string;
}) => void;

export interface BudgetProjectionContext {
  budget: OrchestratorConfig['budget'];
  budgetSamples: Map<string, BudgetUsageSample[]>;
  nowMs: number;
}

export interface BudgetWorkflowContext extends BudgetProjectionContext {
  logger?: StructuredLogger;
  recordRuntimeEvent: RuntimeEventRecorder;
}

export interface BudgetHardLimitDecision {
  stopReasonCode: string;
  stopReasonDetail: string;
  phase: 'failed' | 'blocked_input';
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

export function computeIssueBudgetProjection(params: BudgetProjectionContext & {
  issueId: string;
  currentAttemptTokens: number;
  telemetryStatus: 'available' | 'pending' | 'unavailable';
  forcedStatus?: BudgetRuntimeProjection['budget_status'];
  forcedMessage?: string | null;
}): BudgetRuntimeProjection {
  if (!params.budget) {
    return defaultBudgetProjection();
  }

  const samples = pruneBudgetSamples(params.budget, params.budgetSamples, params.issueId, params.nowMs);
  const selected = selectBudgetCandidate({
    budget: params.budget,
    samples,
    currentAttemptTokens: params.currentAttemptTokens
  });
  return computeBudgetProjection({
    budget: params.budget,
    selected,
    telemetryStatus: params.telemetryStatus,
    forcedStatus: params.forcedStatus,
    forcedMessage: params.forcedMessage
  });
}

export function applyBudgetTelemetryUnavailable(params: BudgetWorkflowContext & {
  runningEntry: RunningEntry;
  workerEvent: WorkerObservabilityEvent;
}): void {
  const { budget, runningEntry, workerEvent } = params;
  if (!budgetConfigured(budget)) {
    return;
  }
  if (!isTerminalTurnEvent(workerEvent.event) || runningEntry.token_telemetry_status !== 'unavailable') {
    return;
  }

  runningEntry.budget = computeIssueBudgetProjection({
    ...params,
    issueId: runningEntry.issue.id,
    currentAttemptTokens: runningEntry.tokens.total_tokens,
    telemetryStatus: 'unavailable',
    forcedStatus: 'telemetry_unavailable',
    forcedMessage: 'Budget accounting unavailable because runtime token telemetry was not reported.'
  });
  params.logger?.log({
    level: 'warn',
    event: CANONICAL_EVENT.budget.telemetryUnavailable,
    message: 'budget telemetry unavailable',
    context: {
      issue_id: runningEntry.issue.id,
      issue_identifier: runningEntry.identifier
    }
  });
  params.recordRuntimeEvent({
    event: CANONICAL_EVENT.budget.telemetryUnavailable,
    severity: 'warn',
    issue_identifier: runningEntry.identifier,
    session_id: runningEntry.session_id ?? undefined,
    detail: 'runtime token telemetry unavailable for budget accounting'
  });
}

export function updateRunningBudgetProjection(params: BudgetProjectionContext & {
  issueId: string;
  runningEntry: RunningEntry;
  currentAttemptTokens: number;
  telemetryStatus: 'available' | 'pending' | 'unavailable';
}): void {
  params.runningEntry.budget = computeIssueBudgetProjection(params);
}

export function evaluateBudgetEnforcement(params: BudgetWorkflowContext & {
  issueId: string;
  runningEntry: RunningEntry;
}): BudgetHardLimitDecision | null {
  const { budget, issueId, runningEntry } = params;
  if (!budgetConfigured(budget)) {
    return null;
  }
  if (runningEntry.token_telemetry_status !== 'available') {
    return null;
  }
  if (!budget || runningEntry.budget_hard_limit_enforced) {
    return null;
  }

  const projection = computeIssueBudgetProjection({
    ...params,
    currentAttemptTokens: runningEntry.tokens.total_tokens,
    telemetryStatus: 'available'
  });
  runningEntry.budget = projection;
  if (projection.budget_status === 'warning' && !runningEntry.budget_warning_emitted) {
    runningEntry.budget_warning_emitted = true;
    params.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.budget.warningThresholdCrossed,
      message: 'budget warning threshold crossed',
      context: {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        budget_usage_tokens: projection.budget_usage_tokens,
        budget_limit_tokens: projection.budget_limit_tokens,
        budget_policy: projection.budget_policy
      }
    });
    params.recordRuntimeEvent({
      event: CANONICAL_EVENT.budget.warningThresholdCrossed,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: `usage=${projection.budget_usage_tokens} limit=${projection.budget_limit_tokens}`
    });
  }

  if (projection.budget_status !== 'hard_limited') {
    return null;
  }

  const samples = pruneBudgetSamples(budget, params.budgetSamples, issueId, params.nowMs);
  const triggeringCandidate = selectBudgetCandidate({
    budget,
    samples,
    currentAttemptTokens: runningEntry.tokens.total_tokens
  });
  runningEntry.budget_hard_limit_enforced = true;
  const scopeDetail = triggeringCandidate ? `${budgetScopeLabel(triggeringCandidate.scope)} ` : '';
  const detail = `Budget hard limit exceeded: ${scopeDetail}usage ${projection.budget_usage_tokens} tokens, limit ${projection.budget_limit_tokens} tokens.`;
  runningEntry.budget = {
    ...projection,
    budget_message:
      budget.hard_limit_policy === 'block_requires_resume'
        ? `${detail} Continuation blocked until manual resume.`
        : `${detail} Attempt terminated by budget policy.`
  };
  params.logger?.log({
    level: 'warn',
    event: CANONICAL_EVENT.budget.hardLimitExceeded,
    message: 'budget hard limit exceeded',
    context: {
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      budget_usage_tokens: projection.budget_usage_tokens,
      budget_limit_tokens: projection.budget_limit_tokens,
      budget_policy: projection.budget_policy
    }
  });
  params.recordRuntimeEvent({
    event: CANONICAL_EVENT.budget.hardLimitExceeded,
    severity: 'warn',
    issue_identifier: runningEntry.identifier,
    session_id: runningEntry.session_id ?? undefined,
    detail: runningEntry.budget?.budget_message ?? detail
  });

  return {
    stopReasonCode:
      budget.hard_limit_policy === 'terminate_attempt'
        ? REASON_CODES.attemptTerminatedBudgetLimitExceeded
        : REASON_CODES.operatorBudgetLimitExceeded,
    stopReasonDetail:
      runningEntry.budget?.budget_message ??
      `Budget hard limit exceeded: usage ${runningEntry.budget?.budget_usage_tokens} tokens, limit ${runningEntry.budget?.budget_limit_tokens} tokens.`,
    phase: budget.hard_limit_policy === 'terminate_attempt' ? 'failed' : 'blocked_input'
  };
}

export function recordIssueBudgetUsageSample(params: BudgetProjectionContext & {
  issueId: string;
  totalTokens: number;
  timestampMs: number;
}): void {
  if (!budgetConfigured(params.budget) || params.totalTokens <= 0) {
    return;
  }
  const samples = pruneBudgetSamples(params.budget, params.budgetSamples, params.issueId, params.timestampMs);
  params.budgetSamples.set(
    params.issueId,
    recordBudgetUsageSample({
      budget: params.budget,
      samples,
      totalTokens: params.totalTokens,
      timestampMs: params.timestampMs
    })
  );
}

export function applyBudgetBlockedTerminationEvidence(params: {
  blockedEntry: BlockedEntry | undefined;
  stopReasonDetail: string;
  terminationResult: WorkerTerminationResult;
}): boolean {
  const { blockedEntry } = params;
  if (!blockedEntry || blockedEntry.stop_reason_code !== REASON_CODES.operatorBudgetLimitExceeded) {
    return false;
  }

  blockedEntry.stop_reason_detail = params.stopReasonDetail;
  blockedEntry.worker_termination_result = cloneWorkerTerminationResult(params.terminationResult);
  if (blockedEntry.budget) {
    blockedEntry.budget = {
      ...blockedEntry.budget,
      budget_message: params.stopReasonDetail
    };
  }
  return true;
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
