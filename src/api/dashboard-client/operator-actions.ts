import { fetchJson, loadStateViaPoll, setRefreshStatus } from './connection';
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
