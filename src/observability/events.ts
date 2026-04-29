export const EVENT_VOCABULARY_VERSION = 'v2';

export type RuntimeEventSeverity = 'info' | 'warn' | 'error';

export const CANONICAL_EVENT = {
  workflow: {
    reloadSucceeded: 'workflow.reload.succeeded',
    reloadFailed: 'workflow.reload.failed',
    pathSwitched: 'workflow.path.switched',
    reloadForced: 'workflow.reload.forced'
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
    toolInputAutoAnswered: 'codex.tool_input.auto_answered',
    toolCallCompleted: 'codex.tool.completed',
    toolCallFailed: 'codex.tool.failed',
    unsupportedToolCall: 'codex.tool.unsupported',
    unsupportedServerRequest: 'codex.protocol.unsupported_request',
    protocolMalformedLine: 'codex.protocol.malformed_line',
    sideOutput: 'codex.side_output',
    turnWaiting: 'codex.turn.waiting'
  },
  orchestration: {
    dispatchValidationFailed: 'orchestration.dispatch.validation.failed',
    dispatchValidationRecovered: 'orchestration.dispatch.validation.recovered',
    dispatchAttemptStarted: 'orchestration.dispatch.attempt.started',
    dispatchSpawnSucceeded: 'orchestration.dispatch.spawn.succeeded',
    dispatchSpawnFailed: 'orchestration.dispatch.spawn.failed',
    retryScheduled: 'orchestration.retry.scheduled',
    workerExitHandled: 'orchestration.worker.exit.handled',
    workerTerminated: 'orchestration.worker.terminated',
    workerEvent: 'orchestration.worker.event',
    workerStalled: 'orchestration.worker.stalled',
    workerHostSlotsExhausted: 'orchestration.worker.host_slots_exhausted',
    blockedInputScheduled: 'orchestration.blocked_input.scheduled',
    blockedInputResumed: 'orchestration.blocked_input.resumed',
    blockedInputCleared: 'orchestration.blocked_input.cleared'
  },
  agentRunner: {
    attemptStarted: 'agent_runner.attempt.started',
    attemptCompleted: 'agent_runner.attempt.completed',
    attemptFailed: 'agent_runner.attempt.failed'
  },
  workspace: {
    provisionStart: 'workspace.provision.start',
    provisionSuccess: 'workspace.provision.success',
    provisionFailed: 'workspace.provision.failed',
    provisionReused: 'workspace.provision.reused',
    provisionFailureCleanupSucceeded: 'workspace.provision.failure_cleanup.succeeded',
    provisionFailureCleanupFailed: 'workspace.provision.failure_cleanup.failed',
    copyIgnoredStart: 'workspace.copy_ignored.start',
    copyIgnoredSuccess: 'workspace.copy_ignored.success',
    copyIgnoredFailed: 'workspace.copy_ignored.failed',
    finalizationFallback: 'workspace.finalization.fallback',
    teardownStart: 'workspace.teardown.start',
    teardownSuccess: 'workspace.teardown.success',
    teardownFailed: 'workspace.teardown.failed',
    integrityCheckStart: 'workspace.integrity.check.start',
    integrityCheckSuccess: 'workspace.integrity.check.success',
    integrityCheckFailed: 'workspace.integrity.check.failed',
    integrityReconcileStart: 'workspace.integrity.reconcile.start',
    integrityReconcileSuccess: 'workspace.integrity.reconcile.success',
    integrityReconcileFailed: 'workspace.integrity.reconcile.failed'
  },
  tracker: {
    candidateFetchFailed: 'tracker.candidates.fetch_failed',
    retryFetchFailed: 'tracker.retry.fetch_failed',
    stateRefreshFailed: 'tracker.state.refresh.failed',
    githubIssueLinkMissing: 'tracker.github_issue_link.missing'
  },
  runtime: {
    argsResolved: 'runtime.args.resolved',
    loggingConfigured: 'runtime.logging.configured',
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
