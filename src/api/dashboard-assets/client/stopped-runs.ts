export function renderStoppedRunsSource(): string {
  return `  function recoveryStatusLabel(status) {
    switch (status) {
      case 'resume_available':
        return 'Resume available';
      case 'active_issue_present':
        return 'Active issue present';
      case 'capability_mismatch':
        return 'Capability mismatch';
      case 'resume_unavailable':
        return 'Resume unavailable';
      case 'inspect_forensics':
      default:
        return 'Inspect forensics';
    }
  }

  function renderStoppedRunRecovery(payload) {
    if (!state.stoppedRunRecoveryLoaded) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'Stopped-run recovery detail loads on demand.';
      elements.stoppedRunRecoveryList.replaceChildren(empty);
      return;
    }

    const acknowledged = new Set(JSON.parse(window.localStorage.getItem('symphony.stoppedRunAcknowledged') || '[]'));
    const entries = (payload.stopped_runs || []).filter(function (entry) {
      return !acknowledged.has(entry.run_id);
    });
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No recent stopped runs need recovery.';
      elements.stoppedRunRecoveryList.replaceChildren(empty);
      return;
    }

    const cards = entries.map((entry) => {
      const card = document.createElement('article');
      card.className = 'recovery-card' + (entry.capability_mismatch ? ' recovery-card-warning' : '');

      const header = document.createElement('div');
      header.className = 'recovery-card-head';
      const title = document.createElement('h3');
      title.textContent = entry.issue_identifier;
      const status = document.createElement('span');
      status.className = 'status-pill ' + (entry.resume_valid ? 'pending' : entry.capability_mismatch ? 'failed' : 'actionability-recommended');
      status.textContent = recoveryStatusLabel(entry.recovery_status);
      header.append(title, status);

      const meta = document.createElement('dl');
      meta.className = 'recovery-grid';
      const addMeta = function (label, value) {
        const group = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = label;
        const description = document.createElement('dd');
        description.textContent = value || 'n/a';
        group.append(term, description);
        meta.append(group);
      };
      addMeta('Run', entry.run_id);
      addMeta('Thread', entry.thread_id);
      addMeta('Session', entry.session_id);
      addMeta('Turn', entry.turn_id);
      addMeta('Last relevant', formatDate(entry.last_relevant_at));
      addMeta('Terminal', entry.terminal_status + (entry.terminal_reason_code ? ' / ' + entry.terminal_reason_code : ''));
      addMeta('Root cause', (entry.root_cause_status || 'unknown') + (entry.root_cause_reason_code ? ' / ' + getActionRequiredLabel(entry.root_cause_reason_code) : ''));
      addMeta('Current recovery', recoveryStatusLabel(entry.recovery_status));

      const detail = document.createElement('p');
      detail.className = 'muted';
      detail.textContent =
        'Terminal detail: ' +
        (entry.terminal_reason_detail || 'n/a') +
        ' | Root-cause detail: ' +
        (entry.root_cause_reason_detail || 'n/a');

      const capability = document.createElement('p');
      capability.className = entry.capability_mismatch ? 'capability-warning-text' : 'muted';
      capability.textContent = entry.capability_mismatch && entry.capability_warning
        ? 'Resume disabled: ' + entry.capability_warning.unsupported_capability_message + ' Recovery: ' + entry.capability_warning.recommended_recovery_action
        : (entry.resume_disabled_reason || 'Resume is available from API recovery metadata.');

      const actions = document.createElement('div');
      actions.className = 'action-cell recovery-actions';
      const inspect = createActionButton('Inspect Forensics', 'ghost-button', function () {
        window.open(entry.actions.inspect_forensics_url, '_blank', 'noopener');
      });
      const inspectThread = createActionButton('Inspect Thread', 'ghost-button', function () {
        if (entry.actions.inspect_thread_url) {
          window.open(entry.actions.inspect_thread_url, '_blank', 'noopener');
        }
      });
      inspectThread.disabled = !entry.actions.inspect_thread_url;
      const copyThread = createActionButton('Copy Thread', 'ghost-button', function () {
        copyText(entry.thread_id || '');
      });
      copyThread.disabled = !entry.actions.copy_thread_id_supported;
      const copySession = createActionButton('Copy Session', 'ghost-button', function () {
        copyText(entry.session_id || '');
      });
      copySession.disabled = !entry.actions.copy_session_id_supported;
      const resume = createActionButton('Resume', 'ghost-button', function () {
        if (entry.resume_valid) {
          void resumeBlockedIssue(entry.issue_identifier);
        }
      });
      resume.disabled = !entry.resume_valid;
      const acknowledge = createActionButton('Acknowledge Cancellation', 'ghost-button', function () {
        acknowledged.add(entry.run_id);
        window.localStorage.setItem('symphony.stoppedRunAcknowledged', JSON.stringify(Array.from(acknowledged)));
        renderStoppedRunRecovery(payload);
      });
      actions.append(inspect, inspectThread, copyThread, copySession, resume, acknowledge);

      card.append(header, meta, detail, capability, actions);
      return card;
    });

    elements.stoppedRunRecoveryList.replaceChildren(...cards);
  }

  function normalizeStoppedRunRecoveryPayload(recovery) {
    return {
      stopped_runs: recovery && Array.isArray(recovery.stopped_runs) ? recovery.stopped_runs : [],
      counts: {
        stopped:
          recovery && recovery.counts && typeof recovery.counts.stopped === 'number'
            ? recovery.counts.stopped
            : 0
      }
    };
  }

  function mergeStoppedRunRecoveryPayload(payload, recoveryPayload) {
    return {
      ...payload,
      stopped_runs: recoveryPayload.stopped_runs || [],
      counts: {
        ...payload.counts,
        stopped: recoveryPayload.counts && typeof recoveryPayload.counts.stopped === 'number' ? recoveryPayload.counts.stopped : 0
      }
    };
  }

  async function loadStoppedRunRecovery() {
    if (state.stoppedRunRecoveryLoading) {
      return;
    }
    state.stoppedRunRecoveryLoading = true;
    if (elements.stoppedRunRecoveryLoad) {
      elements.stoppedRunRecoveryLoad.disabled = true;
    }
    try {
      const recovery = await fetchJson('/api/v1/stopped-runs/recovery');
      state.stoppedRunRecoveryLoaded = true;
      state.stoppedRunRecoveryPayload = normalizeStoppedRunRecoveryPayload(recovery);
      if (state.payload) {
        state.payload = mergeStoppedRunRecoveryPayload(state.payload, state.stoppedRunRecoveryPayload);
        state.lastGoodPayload = state.payload;
        renderOverview(state.payload);
        renderStoppedRunRecovery(state.payload);
      } else {
        renderStoppedRunRecovery(state.stoppedRunRecoveryPayload);
      }
      setRefreshStatus('Stopped-run recovery loaded', false);
    } catch (error) {
      setRefreshStatus('Stopped-run recovery load failed: ' + String(error), true);
    } finally {
      state.stoppedRunRecoveryLoading = false;
      if (elements.stoppedRunRecoveryLoad) {
        elements.stoppedRunRecoveryLoad.disabled = false;
      }
    }
  }

`;
}
