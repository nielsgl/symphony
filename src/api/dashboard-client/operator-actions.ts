import { fetchJson, loadStateViaPoll, setRefreshStatus } from './connection';
import { elements } from './dom';
import { loadIssue } from './issue-detail';
import { state } from './state';

export function buildResumeRequest(reasonNote: any, resumeOverrideReason?: any) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      resumeOverrideReason
        ? { resume_override_reason: resumeOverrideReason, reason_note: reasonNote }
        : { reason_note: reasonNote }
    )
  };
}

export function buildCancelRequest(reasonNote: any, cancelReason?: any) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cancel_reason: cancelReason || reasonNote, reason_note: reasonNote, confirmed: true })
  };
}

export function buildOperatorActionRequest(reasonNote: any, destructive: any) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason_note: reasonNote, confirmed: destructive ? true : undefined })
  };
}

export function buildBlockedInputRequest(pending: any, reasonNote: any, answer: any) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: pending.request_id,
      reason_note: reasonNote,
      answer: answer
    })
  };
}

export function buildDrainControlRequest(reason?: any, extra: Record<string, unknown> = {}) {
  const body = { ...extra } as Record<string, unknown>;
  if (reason) {
    body.reason = reason;
  }
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function describeDrainControlBlockers(payload: any) {
  const blockers = Array.isArray(payload && payload.blockers)
    ? payload.blockers
    : payload && payload.quiescence && Array.isArray(payload.quiescence.blockers)
      ? payload.quiescence.blockers
      : [];
  return blockers
    .map(function (blocker: any) {
      return blocker.reason || blocker.detail || blocker.category || null;
    })
    .filter(Boolean)
    .join('; ');
}

function setDrainControlStatus(message: string, isError: boolean) {
  if (elements.drainControlStatus) {
    elements.drainControlStatus.textContent = message;
    elements.drainControlStatus.className = isError ? 'status-error' : 'status-ok';
  }
  setRefreshStatus(message, isError);
}

async function postDrainControl(url: string, init: any) {
  const response = await fetch(url, init);
  const payload = await response.json();
  return { response, payload };
}

export async function enterDrainMode() {
  try {
    const reason = window.prompt('Reason for entering Drain Mode', 'safe runtime restart');
    if (!reason) {
      setDrainControlStatus('Drain Mode entry skipped: reason is required', true);
      return;
    }
    await fetchJson('/api/v1/drain-mode/enter', buildDrainControlRequest(reason));
    setDrainControlStatus('Drain Mode entry requested', false);
    await loadStateViaPoll();
  } catch (error) {
    setDrainControlStatus('Drain Mode entry failed: ' + String(error), true);
  }
}

export async function exitDrainMode() {
  try {
    const reason = window.prompt('Reason for exiting Drain Mode', 'restart complete');
    if (!reason) {
      setDrainControlStatus('Drain Mode exit skipped: reason is required', true);
      return;
    }
    await fetchJson('/api/v1/drain-mode/exit', buildDrainControlRequest(reason));
    setDrainControlStatus('Drain Mode exit requested', false);
    await loadStateViaPoll();
  } catch (error) {
    setDrainControlStatus('Drain Mode exit failed: ' + String(error), true);
  }
}

export async function waitForDrainQuiescence() {
  try {
    const { payload } = await postDrainControl('/api/v1/drain-mode/wait', buildDrainControlRequest(null, { timeout_ms: 30000 }));
    if (payload && payload.success) {
      setDrainControlStatus('Drain wait complete: shutdown/restart is safe', false);
    } else {
      setDrainControlStatus(
        'Drain wait timed out: ' + (describeDrainControlBlockers(payload) || 'blockers are still present') + '. No forced cancel was requested.',
        true
      );
    }
    await loadStateViaPoll();
  } catch (error) {
    const message = String(error);
    setDrainControlStatus('Drain wait timed out: ' + message + '. No forced cancel was requested.', true);
    await loadStateViaPoll();
  }
}

export async function requestDrainSafeShutdown() {
  try {
    if (!window.confirm('Request safe shutdown now?')) {
      setDrainControlStatus('Safe shutdown skipped: confirmation declined', true);
      return;
    }
    const { payload } = await postDrainControl('/api/v1/drain-mode/shutdown', buildDrainControlRequest(null, { override: false }));
    setDrainControlStatus(
      payload && payload.success
        ? 'Safe shutdown requested'
        : 'Safe shutdown blocked: ' + (describeDrainControlBlockers(payload) || 'blockers are still present'),
      !(payload && payload.success)
    );
    await loadStateViaPoll();
  } catch (error) {
    setDrainControlStatus('Safe shutdown failed: ' + String(error) + '. No forced cancel was requested.', true);
    await loadStateViaPoll();
  }
}

function describeRuntimeUpdateResult(payload: any) {
  const reason = payload && payload.reason_code ? ' (' + payload.reason_code + ')' : '';
  const action = payload && payload.recommended_action ? ' Next: ' + payload.recommended_action.replace(/_/g, ' ') + '.' : '';
  const restart = payload && payload.restart && Array.isArray(payload.restart.command)
    ? ' Restart command: ' + payload.restart.command.join(' ')
    : '';
  return (payload && payload.status ? String(payload.status).replace(/_/g, ' ') : 'runtime update response') + reason + '.' + action + restart;
}

function setRuntimeUpdateStatus(message: string, isError: boolean) {
  if (elements.runtimeUpdateStatus) {
    elements.runtimeUpdateStatus.textContent = message;
    elements.runtimeUpdateStatus.className = isError ? 'status-error' : 'status-ok';
  }
  setRefreshStatus(message, isError);
}

export async function prepareRuntimeUpdate() {
  try {
    const payload = await fetchJson('/api/v1/runtime-update/prepare', buildDrainControlRequest(null));
    setRuntimeUpdateStatus('Runtime update prepare: ' + describeRuntimeUpdateResult(payload), !payload.success);
    await loadStateViaPoll();
  } catch (error) {
    setRuntimeUpdateStatus('Runtime update prepare failed: ' + String(error), true);
    await loadStateViaPoll();
  }
}

export async function applyRuntimeUpdate() {
  try {
    const payload = await fetchJson('/api/v1/runtime-update/apply', buildDrainControlRequest(null));
    setRuntimeUpdateStatus('Runtime update apply: ' + describeRuntimeUpdateResult(payload), !payload.success);
    await loadStateViaPoll();
  } catch (error) {
    setRuntimeUpdateStatus('Runtime update apply failed: ' + String(error), true);
    await loadStateViaPoll();
  }
}

export async function resumeBlockedIssue(issueIdentifier: any, resumeOverrideReason?: any) {
    try {
      const reasonNote = window.prompt('Reason note for resuming this blocked issue', '');
      if (!reasonNote) {
        setRefreshStatus('Resume skipped: reason note is required', true);
        return;
      }
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/resume', buildResumeRequest(reasonNote, resumeOverrideReason));
      setRefreshStatus('Resume requested for ' + payload.issue_identifier, false);
      await loadStateViaPoll();
      if (state.selectedIssue === issueIdentifier) {
        await loadIssue(issueIdentifier);
      }
    } catch (error) {
      setRefreshStatus('Resume failed: ' + String(error), true);
    }
  }

export async function cancelBlockedIssue(issueIdentifier: any, cancelReason?: any) {
    try {
      const reasonNote = window.prompt('Reason note for cancelling this blocked issue', cancelReason || '');
      if (!reasonNote) {
        setRefreshStatus('Cancel skipped: reason note is required', true);
        return;
      }
      if (!window.confirm('Cancel this blocked issue to backlog?')) {
        setRefreshStatus('Cancel skipped: confirmation declined', true);
        return;
      }
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/cancel', buildCancelRequest(reasonNote, cancelReason));
      setRefreshStatus('Cancel requested for ' + payload.issue_identifier + ' -> ' + payload.moved_to_state, false);
      await loadStateViaPoll();
      if (state.selectedIssue === issueIdentifier) {
        await loadIssue(issueIdentifier);
      }
    } catch (error) {
      setRefreshStatus('Cancel failed: ' + String(error), true);
    }
  }

export async function runOperatorAction(issueIdentifier: any, actionPath: any, destructive: any) {
    try {
      const reasonNote = window.prompt('Reason note for ' + actionPath.replace('-', ' '), '');
      if (!reasonNote) {
        setRefreshStatus('Action skipped: reason note is required', true);
        return;
      }
      if (destructive && !window.confirm('Run destructive action "' + actionPath + '" for ' + issueIdentifier + '?')) {
        setRefreshStatus('Action skipped: confirmation declined', true);
        return;
      }
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/' + actionPath, buildOperatorActionRequest(reasonNote, destructive));
      setRefreshStatus('Operator action requested for ' + (payload.issue_identifier || issueIdentifier), false);
      await loadStateViaPoll();
      if (state.selectedIssue === issueIdentifier) {
        await loadIssue(issueIdentifier);
      }
    } catch (error) {
      setRefreshStatus('Operator action failed: ' + String(error), true);
    }
  }

export async function submitBlockedInput(entry: any) {
    try {
      if (!entry.pending_input || !entry.pending_input.request_id) {
        throw new Error('No pending input request payload');
      }
      const pending = entry.pending_input;
      const firstQuestion = Array.isArray(pending.questions) && pending.questions.length ? pending.questions[0] : null;
      const questionId = firstQuestion && firstQuestion.id ? firstQuestion.id : undefined;
      let answer;
      if (pending.input_schema_type === 'options' && firstQuestion && Array.isArray(firstQuestion.options) && firstQuestion.options.length) {
        const labels = firstQuestion.options.map(function (option: any) { return option.label; });
        const selected = window.prompt((pending.prompt_text || 'Select option') + '\\nOptions: ' + labels.join(', '), labels[0] || '');
        answer = { question_id: questionId, option_label: selected || '' };
      } else {
        const text = window.prompt(pending.prompt_text || 'Enter response', '');
        answer = { question_id: questionId, text: text || '' };
      }
      const reasonNote = window.prompt('Reason note for submitting this blocked input', '');
      if (!reasonNote) {
        setRefreshStatus('Input submit skipped: reason note is required', true);
        return;
      }
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(entry.issue_identifier) + '/input', buildBlockedInputRequest(pending, reasonNote, answer));
      setRefreshStatus(
        'Input submitted for ' +
          payload.issue_identifier +
          ' using ' +
          (payload.resume_mode || 'unknown') +
          ' mode (' +
          (payload.resume_reason_code || 'n/a') +
          ')',
        false
      );
      await loadStateViaPoll();
      if (state.selectedIssue === entry.issue_identifier) {
        await loadIssue(entry.issue_identifier);
      }
    } catch (error) {
      setRefreshStatus('Input submit failed: ' + String(error), true);
    }
  }
