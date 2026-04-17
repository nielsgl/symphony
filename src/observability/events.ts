export const EVENT_VOCABULARY_VERSION = 'v2';

export type RuntimeEventSeverity = 'info' | 'warn' | 'error';

export const CANONICAL_EVENT = {
  workflow: {
    reloadSucceeded: 'workflow.reload.succeeded',
    reloadFailed: 'workflow.reload.failed'
  },
  codex: {
    sessionStarted: 'codex.session.started',
    turnStarted: 'codex.turn.started',
    turnCompleted: 'codex.turn.completed',
    turnFailed: 'codex.turn.failed',
    turnCancelled: 'codex.turn.cancelled',
    turnInputRequired: 'codex.turn.input_required',
    startupFailed: 'codex.startup.failed',
    approvalAutoApproved: 'codex.approval.auto_approved',
    toolCallCompleted: 'codex.tool.completed',
    toolCallFailed: 'codex.tool.failed',
    unsupportedToolCall: 'codex.tool.unsupported',
    unsupportedServerRequest: 'codex.protocol.unsupported_request',
    turnWaiting: 'codex.turn.waiting'
  },
  orchestration: {
    dispatchValidationFailed: 'orchestration.dispatch.validation.failed',
    dispatchValidationRecovered: 'orchestration.dispatch.validation.recovered',
    workerEvent: 'orchestration.worker.event',
    workerStalled: 'orchestration.worker.stalled',
    workerHostSlotsExhausted: 'orchestration.worker.host_slots_exhausted'
  },
  tracker: {
    candidateFetchFailed: 'tracker.candidates.fetch_failed',
    retryFetchFailed: 'tracker.retry.fetch_failed',
    stateRefreshFailed: 'tracker.state.refresh.failed'
  },
  runtime: {
    argsResolved: 'runtime.args.resolved',
    securityProfileActive: 'runtime.security.profile.active',
    startupValidationBypassed: 'runtime.startup.validation.bypassed',
    startupStateInitialized: 'runtime.startup.state.initialized',
    startupCleanupCompleted: 'runtime.startup.cleanup.completed',
    startupCleanupFailed: 'runtime.startup.cleanup.failed',
    httpEnabled: 'runtime.http.enabled',
    httpDisabled: 'runtime.http.disabled',
    started: 'runtime.started',
    stopped: 'runtime.stopped',
    guardrailAckRequired: 'runtime.guardrail.ack.required'
  },
  api: {
    serverListening: 'api.server.listening',
    stateRequested: 'api.state.requested',
    stateSnapshotUnavailable: 'api.state.snapshot.unavailable',
    refreshRequested: 'api.refresh.requested',
    issueRequested: 'api.issue.requested',
    routeNotFound: 'api.route.not_found',
    methodNotAllowed: 'api.method.not_allowed',
    localError: 'api.error.local',
    internalError: 'api.error.internal'
  },
  persistence: {
    pruned: 'persistence.pruned',
    recordSessionFailed: 'persistence.session.record_failed',
    recordEventFailed: 'persistence.event.record_failed',
    startRunFailed: 'persistence.run.start_failed',
    completeRunFailed: 'persistence.run.complete_failed'
  }
} as const;
