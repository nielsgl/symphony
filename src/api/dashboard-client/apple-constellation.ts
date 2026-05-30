import { elements } from './dom';
import { renderConstellationCore } from './apple-constellation-core';
import { renderConstellationGravity } from './apple-constellation-gravity';
import { renderConstellationInterlocks } from './apple-constellation-interlocks';

let lastCoreSignature = '';

function activeSignature(active: any[], focus: any): string {
  return JSON.stringify({
    focus: focus && (focus.issue_identifier || focus.identifier || focus.issue_id || null),
    active: active.map((entry) => ({
      identifier: entry?.issue_identifier || entry?.identifier || entry?.issue_id || null,
      title: entry?.issue_title || entry?.title || entry?.headline || null,
      phase: entry?.current_phase || entry?.progress_signal_state || null,
      attempt: entry?.retry_attempt || entry?.run_attempt || entry?.attempt || null,
      thread: entry?.thread_id || entry?.previous_thread_id || entry?.session_thread_id || null,
      session: entry?.session_id || entry?.previous_session_id || null,
      message: entry?.conversation_latest?.summary || entry?.last_message || entry?.last_event_summary || null,
      eventCount: Array.isArray(entry?.recent_events) ? entry.recent_events.length : 0,
      lastEventAt: entry?.last_event_at || entry?.updated_at || null,
      tokenTotal: entry?.tokens?.total_tokens || null,
      contextWindow: entry?.tokens?.model_context_window || null
    }))
  });
}

export function renderAppleConstellation(payload: any) {
  if (!elements.constellationCore) {
    return;
  }

  const running = Array.isArray(payload && payload.running) ? payload.running : [];
  const blocked = Array.isArray(payload && payload.blocked) ? payload.blocked : [];
  const retry = Array.isArray(payload && payload.retry) ? payload.retry : [];
  const active = ([] as any[]).concat(running, blocked, retry);
  const focus =
    active.find((entry) => {
      const identifier = String(entry?.issue_identifier || entry?.identifier || entry?.issue_id || '').trim();
      return identifier === 'NIE-300';
    }) ||
    running[0] ||
    blocked[0] ||
    retry[0] ||
    null;

  renderConstellationGravity({ running, blocked, retry, focus });
  const nextCoreSignature = activeSignature(active, focus);
  if (nextCoreSignature !== lastCoreSignature) {
    lastCoreSignature = nextCoreSignature;
    renderConstellationCore({ running, blocked, retry, focus });
  }
  renderConstellationInterlocks({ running, blocked, retry, focus, payload });
}
