import type { OrchestratorState, RunningEntry } from '../../orchestrator';
import { asIsoDate } from './time';

export function projectRunnerEventEvidence(event: RunningEntry['recent_events'][number]) {
  return {
    at: asIsoDate(event.at_ms),
    event: event.event,
    message: event.message,
    ...(event.reason_code !== undefined ? { reason_code: event.reason_code } : {}),
    ...(event.request_method !== undefined ? { request_method: event.request_method } : {}),
    ...(event.request_category !== undefined ? { request_category: event.request_category } : {}),
    ...(event.tool_call_id !== undefined ? { tool_call_id: event.tool_call_id } : {}),
    ...(event.tool_name !== undefined ? { tool_name: event.tool_name } : {}),
    ...(event.protocol_warning !== undefined ? { protocol_warning: { ...event.protocol_warning } } : {}),
    ...(event.model_reroute !== undefined
      ? { model_reroute: event.model_reroute ? { ...event.model_reroute } : null }
      : {}),
    ...(event.requested_model !== undefined ? { requested_model: event.requested_model } : {}),
    ...(event.effective_model !== undefined ? { effective_model: event.effective_model } : {})
  };
}

export function projectRuntimeEventEvidence(event: OrchestratorState['recent_runtime_events'][number]) {
  return {
    at: asIsoDate(event.at_ms),
    event: event.event,
    severity: event.severity,
    issue_identifier: event.issue_identifier,
    session_id: event.session_id,
    detail: event.detail,
    ...(event.reason_code !== undefined ? { reason_code: event.reason_code } : {}),
    ...(event.request_method !== undefined ? { request_method: event.request_method } : {}),
    ...(event.request_category !== undefined ? { request_category: event.request_category } : {}),
    ...(event.tool_call_id !== undefined ? { tool_call_id: event.tool_call_id } : {}),
    ...(event.tool_name !== undefined ? { tool_name: event.tool_name } : {}),
    ...(event.protocol_warning !== undefined ? { protocol_warning: { ...event.protocol_warning } } : {}),
    ...(event.model_reroute !== undefined
      ? { model_reroute: event.model_reroute ? { ...event.model_reroute } : null }
      : {}),
    ...(event.requested_model !== undefined ? { requested_model: event.requested_model } : {}),
    ...(event.effective_model !== undefined ? { effective_model: event.effective_model } : {})
  };
}

export function projectQuarantinedRunningEvents(entry: RunningEntry) {
  return (entry.quarantined_events ?? []).map((event) => ({
    at: asIsoDate(event.at_ms),
    event: event.event,
    message: event.message,
    codex_app_server_pid: event.codex_app_server_pid,
    session_id: event.session_id,
    thread_id: event.thread_id,
    turn_id: event.turn_id,
    active_codex_app_server_pid: event.active_codex_app_server_pid,
    worker_instance_id: event.worker_instance_id ?? null,
    active_worker_instance_id: event.active_worker_instance_id ?? null,
    run_id: event.run_id ?? null,
    issue_run_id: event.issue_run_id ?? null,
    attempt_id: event.attempt_id ?? null,
    active_run_id: event.active_run_id ?? null,
    active_issue_run_id: event.active_issue_run_id ?? null,
    active_attempt_id: event.active_attempt_id ?? null,
    active_session_id: event.active_session_id,
    active_thread_id: event.active_thread_id,
    active_turn_id: event.active_turn_id,
    reason: event.reason
  }));
}
