import { DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION, UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE } from './dynamic-tool-capability';

export const REASON_CODE_REGISTRY_VERSION = '2026-05-05.v1';

export type ReasonCodeClassification =
  | 'healthy'
  | 'awaiting_input'
  | 'stalled_waiting'
  | 'retrying'
  | 'blocked_input'
  | 'failed';

export type ReasonCodeActionability = 'none' | 'recommended' | 'required';

export interface ReasonCodeDefinition {
  reason_code: string;
  classification: ReasonCodeClassification;
  actionability: ReasonCodeActionability;
  recommended_actions: string[];
  label: string;
  headline: string;
  detail: string;
  expected_transition: string | null;
}

export const REASON_CODES = {
  normalCompletion: 'normal_completion',
  maxTurnsReached: 'max_turns_reached',
  handoffStateReached: 'handoff_state_reached',
  issueLeftActiveStates: 'issue_left_active_states',
  issueStateMissing: 'issue_state_missing',
  terminalStateReached: 'terminal_state_reached',
  dispatchStarted: 'dispatch_started',
  attemptStarted: 'attempt_started',
  codexSessionStarted: 'codex_session_started',
  workerExitAbnormal: 'worker_exit_abnormal',
  workerStalled: 'worker_stalled',
  slotsExhausted: 'slots_exhausted',
  retryFetchFailed: 'retry_fetch_failed',
  spawnFailed: 'spawn_failed',
  manualResume: 'manual_resume',
  operatorRequeueRequested: 'operator_requeue_requested',
  operatorRetryStepRequested: 'operator_retry_step_requested',
  turnInputRequired: 'turn_input_required',
  turnWaitingThresholdExceeded: 'turn_waiting_threshold_exceeded',
  operatorWorkspaceConflict: 'operator_action_required_workspace_conflict',
  operatorNoProgressRedispatchBlocked: 'operator_action_required_no_progress_redispatch_blocked',
  operatorBudgetLimitExceeded: 'operator_action_required_budget_limit_exceeded',
  attemptTerminatedBudgetLimitExceeded: 'attempt_terminated_budget_limit_exceeded',
  unsupportedDynamicToolConsoleResume: UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE,
  awaitingHumanReviewScopeIncomplete: 'awaiting_human_review_scope_incomplete',
  issueStateRefreshFailed: 'issue_state_refresh_failed',
  unsafeWorkspaceRoot: 'unsafe_workspace_root',
  workspaceEmpty: 'workspace_empty',
  unknownRuntimeReason: 'unknown_runtime_reason'
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

export const CANONICAL_REASON_CODE_REGISTRY = {
  [REASON_CODES.normalCompletion]: {
    reason_code: REASON_CODES.normalCompletion,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Normal Completion',
    headline: 'Run is progressing',
    detail: 'The worker completed normally and the orchestrator is continuing while the issue remains active.',
    expected_transition: 'Run continues until completion or a runtime signal changes state'
  },
  [REASON_CODES.maxTurnsReached]: {
    reason_code: REASON_CODES.maxTurnsReached,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Max Turns Reached',
    headline: 'Run turn budget reached',
    detail: 'The worker completed normally after reaching the configured maximum turns for the current attempt.',
    expected_transition: 'Orchestrator continuation may schedule the next attempt while the issue remains active'
  },
  [REASON_CODES.handoffStateReached]: {
    reason_code: REASON_CODES.handoffStateReached,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Handoff State Reached',
    headline: 'Run stopped at handoff',
    detail: 'The worker completed normally and stopped because the refreshed issue state is configured as a handoff point.',
    expected_transition: 'Separate handoff automation may dispatch the next workflow'
  },
  [REASON_CODES.issueLeftActiveStates]: {
    reason_code: REASON_CODES.issueLeftActiveStates,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Issue Left Active States',
    headline: 'Run stopped after state change',
    detail: 'The worker completed normally and stopped because the refreshed issue state is no longer active.',
    expected_transition: 'No same-workflow continuation is scheduled'
  },
  [REASON_CODES.issueStateMissing]: {
    reason_code: REASON_CODES.issueStateMissing,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Issue State Missing',
    headline: 'Run stopped after missing refresh result',
    detail: 'The worker completed normally and stopped because the tracker refresh did not return the issue.',
    expected_transition: 'No continuation is scheduled until the issue is visible again'
  },
  [REASON_CODES.terminalStateReached]: {
    reason_code: REASON_CODES.terminalStateReached,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Terminal State Reached',
    headline: 'Run stopped at terminal state',
    detail: 'The worker completed normally and the refreshed issue state is terminal, so terminal cleanup applies.',
    expected_transition: 'Workspace cleanup runs and no continuation is scheduled'
  },
  [REASON_CODES.dispatchStarted]: {
    reason_code: REASON_CODES.dispatchStarted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Dispatch Started',
    headline: 'Run dispatch started',
    detail: 'The orchestrator started dispatching an attempt.',
    expected_transition: 'Worker spawn and attempt lifecycle events follow'
  },
  [REASON_CODES.attemptStarted]: {
    reason_code: REASON_CODES.attemptStarted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Attempt Started',
    headline: 'Attempt started',
    detail: 'A worker attempt was persisted under the execution graph.',
    expected_transition: 'Thread and turn lifecycle events follow'
  },
  [REASON_CODES.codexSessionStarted]: {
    reason_code: REASON_CODES.codexSessionStarted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Codex Session Started',
    headline: 'Codex session started',
    detail: 'A Codex thread was persisted under the current attempt.',
    expected_transition: 'Turn lifecycle events follow'
  },
  [REASON_CODES.workerExitAbnormal]: {
    reason_code: REASON_CODES.workerExitAbnormal,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the retry; inspect worker logs if the same reason repeats'],
    label: 'Worker Exit Abnormal',
    headline: 'Run is waiting to retry',
    detail: 'The worker exited abnormally and the orchestrator scheduled a retry.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.workerStalled]: {
    reason_code: REASON_CODES.workerStalled,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the retry; inspect recent runtime events if stalls repeat'],
    label: 'Worker Stalled',
    headline: 'Run is waiting to retry',
    detail: 'The worker stopped producing progress before the configured stall timeout.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.slotsExhausted]: {
    reason_code: REASON_CODES.slotsExhausted,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Wait for an orchestrator slot to free up', 'Review worker slot configuration if this persists'],
    label: 'Slots Exhausted',
    headline: 'Run is waiting to retry',
    detail: 'No orchestrator or worker-host slots are currently available.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.retryFetchFailed]: {
    reason_code: REASON_CODES.retryFetchFailed,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Inspect tracker connectivity and retry state refresh errors'],
    label: 'Retry Fetch Failed',
    headline: 'Run is waiting to retry',
    detail: 'The orchestrator could not refresh issue state while processing a retry.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.spawnFailed]: {
    reason_code: REASON_CODES.spawnFailed,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Inspect worker launch configuration and retry logs'],
    label: 'Spawn Failed',
    headline: 'Run is waiting to retry',
    detail: 'The orchestrator could not spawn the worker process.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.manualResume]: {
    reason_code: REASON_CODES.manualResume,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the resumed run'],
    label: 'Manual Resume',
    headline: 'Run is waiting to retry',
    detail: 'The run was manually resumed and queued for dispatch.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.operatorRequeueRequested]: {
    reason_code: REASON_CODES.operatorRequeueRequested,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the requeued run'],
    label: 'Operator Requeue Requested',
    headline: 'Run was requeued by an operator',
    detail: 'An operator explicitly requeued the issue from the action console.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.operatorRetryStepRequested]: {
    reason_code: REASON_CODES.operatorRetryStepRequested,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the retried step'],
    label: 'Operator Retry Step Requested',
    headline: 'Failed step retry was requested',
    detail: 'An operator explicitly retried the last failed or stalled step.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.turnInputRequired]: {
    reason_code: REASON_CODES.turnInputRequired,
    classification: 'awaiting_input',
    actionability: 'required',
    recommended_actions: ['Open the issue detail and answer the pending input request'],
    label: 'Turn Input Required',
    headline: 'Run is awaiting operator input',
    detail: 'Codex requested input that requires an operator response.',
    expected_transition: 'Run continues after input is submitted'
  },
  [REASON_CODES.turnWaitingThresholdExceeded]: {
    reason_code: REASON_CODES.turnWaitingThresholdExceeded,
    classification: 'stalled_waiting',
    actionability: 'required',
    recommended_actions: ['Inspect recent events and decide whether to resume, cancel, or restart'],
    label: 'Turn Waiting Threshold Exceeded',
    headline: 'Run is alive but waiting too long',
    detail: 'The run is still alive through codex.turn.waiting heartbeats after the configured wait threshold.',
    expected_transition: null
  },
  [REASON_CODES.operatorWorkspaceConflict]: {
    reason_code: REASON_CODES.operatorWorkspaceConflict,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Resolve workspace git conflicts', 'Resume or cancel the blocked run'],
    label: 'Workspace Conflict',
    headline: 'Run is blocked on operator input',
    detail: 'The orchestrator paused this run until an operator resolves the workspace conflict.',
    expected_transition: null
  },
  [REASON_CODES.operatorNoProgressRedispatchBlocked]: {
    reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Mark acceptance complete and resume', 'Commit progress and resume', 'Cancel and return to backlog'],
    label: 'No Progress Redispatch Blocked',
    headline: 'Run is blocked on operator input',
    detail: 'Completion gate blocked redispatch because no progress signal was detected.',
    expected_transition: null
  },
  [REASON_CODES.operatorBudgetLimitExceeded]: {
    reason_code: REASON_CODES.operatorBudgetLimitExceeded,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Increase budget and resume', 'Cancel and return to backlog'],
    label: 'Budget Limit Exceeded',
    headline: 'Run is blocked on operator input',
    detail: 'The run exceeded the configured budget and requires manual resume.',
    expected_transition: null
  },
  [REASON_CODES.attemptTerminatedBudgetLimitExceeded]: {
    reason_code: REASON_CODES.attemptTerminatedBudgetLimitExceeded,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Review the budget policy and restart after resolving the cause'],
    label: 'Budget Limit Terminated Attempt',
    headline: 'Run failed',
    detail: 'The run exceeded the configured budget and the budget policy terminated the attempt.',
    expected_transition: null
  },
  [REASON_CODES.unsupportedDynamicToolConsoleResume]: {
    reason_code: REASON_CODES.unsupportedDynamicToolConsoleResume,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: [DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION],
    label: 'Unsupported Console Dynamic Tool Resume',
    headline: 'Console resume cannot run dynamic tools',
    detail:
      'A Symphony-originated dynamic-tool session was continued from a console/TUI environment that rejected dynamic tool execution.',
    expected_transition: null
  },
  [REASON_CODES.awaitingHumanReviewScopeIncomplete]: {
    reason_code: REASON_CODES.awaitingHumanReviewScopeIncomplete,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Complete scope or provide an explicit resume override'],
    label: 'Awaiting Human Review (Scope Incomplete)',
    headline: 'Run is blocked on operator input',
    detail: 'PR is open but scope is incomplete and no progress signal was detected.',
    expected_transition: null
  },
  [REASON_CODES.issueStateRefreshFailed]: {
    reason_code: REASON_CODES.issueStateRefreshFailed,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Inspect tracker refresh errors'],
    label: 'Issue State Refresh Failed',
    headline: 'Run is waiting to retry',
    detail: 'The orchestrator could not refresh tracker state.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.unsafeWorkspaceRoot]: {
    reason_code: REASON_CODES.unsafeWorkspaceRoot,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect workspace configuration and restart after resolving the cause'],
    label: 'Unsafe Workspace Root',
    headline: 'Run failed',
    detail: 'The worker reported an unsafe workspace root.',
    expected_transition: null
  },
  [REASON_CODES.workspaceEmpty]: {
    reason_code: REASON_CODES.workspaceEmpty,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect workspace provisioning and restart after resolving the cause'],
    label: 'Workspace Empty',
    headline: 'Run failed',
    detail: 'The worker reported an empty workspace.',
    expected_transition: null
  },
  [REASON_CODES.unknownRuntimeReason]: {
    reason_code: REASON_CODES.unknownRuntimeReason,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect runtime details and add a canonical reason-code mapping if this is a new known path'],
    label: 'Unknown Runtime Reason',
    headline: 'Run failed',
    detail: 'The runtime emitted a reason that is not in the canonical registry.',
    expected_transition: null
  }
} as const satisfies Record<ReasonCode, ReasonCodeDefinition>;

export function isReasonCode(value: string | null | undefined): value is ReasonCode {
  return Boolean(value && Object.prototype.hasOwnProperty.call(CANONICAL_REASON_CODE_REGISTRY, value));
}

export function getReasonCodeDefinition(value: string | null | undefined): ReasonCodeDefinition | null {
  return isReasonCode(value) ? CANONICAL_REASON_CODE_REGISTRY[value] : null;
}

export function requireReasonCodeDefinition(value: string | null | undefined): ReasonCodeDefinition {
  return getReasonCodeDefinition(value) ?? CANONICAL_REASON_CODE_REGISTRY[REASON_CODES.unknownRuntimeReason];
}

export function listReasonCodeDefinitions(): ReasonCodeDefinition[] {
  return Object.values(CANONICAL_REASON_CODE_REGISTRY).map((definition) => ({ ...definition }));
}

export function listActionRequiredReasonCodes(): ReasonCode[] {
  return listReasonCodeDefinitions()
    .filter((definition) => definition.actionability === 'required')
    .map((definition) => definition.reason_code as ReasonCode);
}
