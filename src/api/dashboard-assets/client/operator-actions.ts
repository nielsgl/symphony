export function renderOperatorActionsSource(): string {
  return `  async function loadIssue(identifier, options) {
    const issueId = (identifier || '').trim();
    if (!issueId) {
      return;
    }
    const loadOptions = options || {};
    if (loadOptions.openPanel !== false && !elements.issuePanel.open) {
      state.suppressIssuePanelToggleLoad = true;
      elements.issuePanel.open = true;
      setTimeout(function () {
        state.suppressIssuePanelToggleLoad = false;
      }, 0);
    }

    try {
      const payload = await fetchJson('/api/v1/' + encodeURIComponent(issueId));
      let diagnostics = null;
      let diagnosticsLoadFailed = false;
      try {
        diagnostics = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueId) + '/diagnostics');
      } catch (_diagnosticsError) {
        diagnosticsLoadFailed = true;
        diagnostics = null;
      }
      state.selectedIssue = issueId;
      elements.issueInput.value = issueId;
      const summaryParts = [];
      summaryParts.push('Status: ' + (payload.status || 'unknown'));
      summaryParts.push('Snapshot: ' + (payload.snapshot_freshness_state || 'unknown') + ' age ' + formatNumber(payload.snapshot_age_ms) + 'ms');
      if (payload.api_degraded_mode) {
        summaryParts.push('API degraded: ' + (payload.api_degraded_reason_code || 'unknown'));
      }
      if (payload.workspace && payload.workspace.path) {
        summaryParts.push('Workspace: ' + payload.workspace.path);
      }
      if (payload.retry && payload.retry.stop_reason_code) {
        summaryParts.push('Stop reason: ' + payload.retry.stop_reason_code);
      }
      if (payload.blocked && payload.blocked.stop_reason_code) {
        summaryParts.push('Blocked reason: ' + getActionRequiredLabel(payload.blocked.stop_reason_code));
      }
      if (payload.retry && payload.retry.previous_session_id) {
        summaryParts.push('Previous session: ' + payload.retry.previous_session_id);
      }
      if (payload.blocked && payload.blocked.previous_session_id) {
        summaryParts.push('Previous session: ' + payload.blocked.previous_session_id);
      }
      if (payload.running && payload.running.current_phase) {
        summaryParts.push('Current phase: ' + payload.running.current_phase);
      }
      if (payload.running && payload.running.turn_control_state) {
        summaryParts.push('Turn control: ' + getTurnControlLabel(payload.running.turn_control_state));
        summaryParts.push('Progress: ' + getProgressSignalLabel(payload.running.progress_signal_state));
      }
      if (payload.running && payload.running.token_telemetry_confidence) {
        summaryParts.push('Token quality: ' + getTokenConfidenceLabel(payload.running.token_telemetry_confidence));
      }
      if (payload.running && payload.running.not_blocked_explainer_text) {
        summaryParts.push('Why not blocked: ' + payload.running.not_blocked_explainer_text);
      }
      if (payload.blocked && payload.blocked.turn_control_state) {
        summaryParts.push('Turn control: ' + getTurnControlLabel(payload.blocked.turn_control_state));
      }
      if ((payload.retry && payload.retry.last_phase) || (payload.blocked && payload.blocked.last_phase)) {
        summaryParts.push('Last phase before stop: ' + ((payload.retry && payload.retry.last_phase) || (payload.blocked && payload.blocked.last_phase)));
      }
      if (payload.operator_explainer) {
        summaryParts.push('Actionability: ' + payload.operator_explainer.actionability);
      }
      const runningOrRetry = payload.running || payload.retry || payload.blocked;
      if (runningOrRetry && runningOrRetry.provisioner_type) {
        summaryParts.push('Provisioner: ' + runningOrRetry.provisioner_type);
      }
      if (runningOrRetry && runningOrRetry.branch_name) {
        summaryParts.push('Branch: ' + runningOrRetry.branch_name);
      }
      if (runningOrRetry && runningOrRetry.workspace_git_status) {
        summaryParts.push('Workspace git: ' + runningOrRetry.workspace_git_status);
      }
      if (runningOrRetry && typeof runningOrRetry.workspace_provisioned === 'boolean') {
        summaryParts.push('Provisioned: ' + (runningOrRetry.workspace_provisioned ? 'yes' : 'no'));
      }
      if (runningOrRetry && typeof runningOrRetry.workspace_is_git_worktree === 'boolean') {
        summaryParts.push('Git worktree: ' + (runningOrRetry.workspace_is_git_worktree ? 'yes' : 'no'));
      }
      if (runningOrRetry) {
        summaryParts.push(formatBudgetSummary(runningOrRetry));
        summaryParts.push(formatDiagnosticSummary(getDiagnosticSummary(runningOrRetry)));
      }
      summaryParts.push(
        diagnostics
          ? 'Detailed diagnostics: loaded'
          : diagnosticsLoadFailed
            ? 'Detailed diagnostics: unavailable'
            : 'Detailed diagnostics: not loaded'
      );
      if (state.runtimeResolution && state.runtimeResolution.workspace_root) {
        summaryParts.push('Runtime workspace root: ' + state.runtimeResolution.workspace_root);
      }
      elements.issueSummary.textContent = summaryParts.join(' • ');
      renderIssueExplainer(payload.operator_explainer || null);
      renderThreadDiagnostics(diagnostics);
      const timeline = Array.isArray(payload.phase_timeline) ? payload.phase_timeline : [];
      const sessionConsole = payload.blocked && Array.isArray(payload.blocked.session_console) ? payload.blocked.session_console : [];
      const timelineText = timeline.length
        ? timeline.map(function (marker) {
            return formatDate(marker.at) + ' | ' + marker.phase + ' | attempt ' + marker.attempt + ' | ' + (marker.detail || 'n/a') + ' | thread ' + (marker.thread_id || 'n/a') + ' | session ' + (marker.session_id || 'n/a');
          }).join('\\n')
        : 'No phase markers yet.';
      const operatorTimelineRows = deriveOperatorTransitionRows(issueId, payload);
      const operatorActions = Array.isArray(payload.operator_actions) ? payload.operator_actions : [];
      const operatorActionText = operatorActions.length
        ? operatorActions.map(function (entry) {
            return formatDate(entry.requested_at_ms) + ' | ' + (entry.actor || 'operator') + ' | ' + entry.action + ' | ' + entry.result + ' | ' + (entry.result_code || 'n/a') + ' | ' + (entry.reason_note || 'no reason note') + ' | ' + (entry.message || 'n/a');
          }).join('\\n')
        : 'No operator action outcomes.';
      const operatorTimelineText = operatorTimelineRows.length
        ? operatorTimelineRows
            .map(function (entry) {
              return (
                formatDate(entry.at) +
                ' | ' +
                entry.label +
                ' | issue ' +
                entry.issue_identifier +
                ' | ' +
                entry.result +
                ' | ' +
                entry.detail
              );
            })
            .join('\\n')
        : 'No operator transition entries.';
      const sessionConsoleText = sessionConsole.length
        ? sessionConsole.map(function (event) {
            return formatDate(event.at) + ' | ' + event.event + ' | ' + (event.message || 'n/a');
          }).join('\\n')
        : 'No session console entries.';
      const budgetText = runningOrRetry ? formatBudgetSummary(runningOrRetry) : 'Budget: not configured';
      elements.issueOutput.textContent =
        'Operator Transition Timeline\\n' +
        operatorTimelineText +
        '\\n\\nOperator Action Outcomes\\n' +
        operatorActionText +
        '\\n\\nExecution Timeline\\n' +
        timelineText +
        '\\n\\nSession Console\\n' +
        sessionConsoleText +
        '\\n\\nBudget\\n' +
        budgetText +
        '\\n\\nIssue JSON (canonical UTC ISO values preserved)\\n' +
        JSON.stringify(payload, null, 2);
      if (state.payload) {
        renderRunning(state.payload);
      }
      scheduleStateSave();
    } catch (error) {
      elements.issueSummary.textContent = 'Issue detail degraded: fallback mode active.';
      renderIssueExplainer(null);
      renderThreadDiagnostics(null);
      elements.issueOutput.textContent =
        'Issue load failed: ' +
        String(error) +
        '\\n\\nFallback message\\nIssue detail payload is unavailable. Available actions remain resume, cancel, refresh, and JSON inspection when the state snapshot contains the issue.';
    }
  }

  async function resumeBlockedIssue(issueIdentifier, resumeOverrideReason) {
    try {
      const reasonNote = window.prompt('Reason note for resuming this blocked issue', '');
      if (!reasonNote) {
        setRefreshStatus('Resume skipped: reason note is required', true);
        return;
      }
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          resumeOverrideReason
            ? { resume_override_reason: resumeOverrideReason, reason_note: reasonNote }
            : { reason_note: reasonNote }
        )
      });
      setRefreshStatus('Resume requested for ' + payload.issue_identifier, false);
      await loadStateViaPoll();
      if (state.selectedIssue === issueIdentifier) {
        await loadIssue(issueIdentifier);
      }
    } catch (error) {
      setRefreshStatus('Resume failed: ' + String(error), true);
    }
  }

  async function cancelBlockedIssue(issueIdentifier, cancelReason) {
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
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cancel_reason: cancelReason || reasonNote, reason_note: reasonNote, confirmed: true })
      });
      setRefreshStatus('Cancel requested for ' + payload.issue_identifier + ' -> ' + payload.moved_to_state, false);
      await loadStateViaPoll();
      if (state.selectedIssue === issueIdentifier) {
        await loadIssue(issueIdentifier);
      }
    } catch (error) {
      setRefreshStatus('Cancel failed: ' + String(error), true);
    }
  }

  async function runOperatorAction(issueIdentifier, actionPath, destructive) {
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
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/' + actionPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason_note: reasonNote, confirmed: destructive ? true : undefined })
      });
      setRefreshStatus('Operator action requested for ' + (payload.issue_identifier || issueIdentifier), false);
      await loadStateViaPoll();
      if (state.selectedIssue === issueIdentifier) {
        await loadIssue(issueIdentifier);
      }
    } catch (error) {
      setRefreshStatus('Operator action failed: ' + String(error), true);
    }
  }

  async function submitBlockedInput(entry) {
    try {
      if (!entry.pending_input || !entry.pending_input.request_id) {
        throw new Error('No pending input request payload');
      }
      const pending = entry.pending_input;
      const firstQuestion = Array.isArray(pending.questions) && pending.questions.length ? pending.questions[0] : null;
      const questionId = firstQuestion && firstQuestion.id ? firstQuestion.id : undefined;
      let answer;
      if (pending.input_schema_type === 'options' && firstQuestion && Array.isArray(firstQuestion.options) && firstQuestion.options.length) {
        const labels = firstQuestion.options.map(function (option) { return option.label; });
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
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(entry.issue_identifier) + '/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: pending.request_id,
          reason_note: reasonNote,
          answer: answer
        })
      });
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

`;
}
