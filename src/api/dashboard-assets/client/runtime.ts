import { REASON_CODES } from '../../../observability/reason-codes';

export function renderRuntimeSource(): string {
  return `  function describeTransition(transition) {
    switch (transition) {
      case 'completion_gate_blocked':
        return { label: 'Completion Gate Blocked', result: 'failure', detail: 'No progress signal detected in redispatch window.' };
      case 'circuit_breaker_opened':
        return { label: 'Circuit Breaker Opened', result: 'failure', detail: 'Respawn threshold reached; operator intervention required.' };
      case 'resume_accepted':
        return { label: 'Resume Accepted', result: 'success', detail: 'Resume request accepted and redispatch restarted.' };
      case 'resume_rejected':
        return { label: 'Resume Rejected', result: 'failure', detail: 'Resume request rejected; resolve blocking condition first.' };
      case 'cancel_accepted':
        return { label: 'Cancel Accepted', result: 'success', detail: 'Issue returned to backlog.' };
      case 'cancel_rejected':
        return { label: 'Cancel Rejected', result: 'failure', detail: 'Cancel request rejected; tracker state unchanged.' };
      default:
        return null;
    }
  }

  function deriveOperatorTransitionRows(issueId, payload) {
    const rows = [];
    const seen = new Set();
    function addRow(at, transition, detail) {
      const key = transition + ':' + String(at || 'n/a') + ':' + String(detail || '');
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const descriptor = describeTransition(transition);
      if (!descriptor) {
        return;
      }
      rows.push({
        at: at || 'n/a',
        issue_identifier: issueId,
        label: descriptor.label,
        result: descriptor.result,
        detail: detail && detail.trim ? (detail.trim() ? detail : descriptor.detail) : descriptor.detail
      });
    }

    const timeline = Array.isArray(payload.phase_timeline) ? payload.phase_timeline : [];
    for (const marker of timeline) {
      const normalized = String(marker && marker.detail ? marker.detail : '').trim().toLowerCase();
      const transition = OPERATOR_TRANSITION_RULES.detailMap[normalized];
      if (transition) {
        addRow(marker.at, transition, marker.detail || null);
      }
    }
    const events = Array.isArray(payload.recent_events) ? payload.recent_events : [];
    for (const entry of events) {
      const transitionByEvent = OPERATOR_TRANSITION_RULES.eventMap[String(entry && entry.event ? entry.event : '')];
      if (transitionByEvent) {
        addRow(entry.at, transitionByEvent, entry.message || null);
      }
      const normalizedMessage = String(entry && entry.message ? entry.message : '').trim().toLowerCase();
      const transitionByMessage = OPERATOR_TRANSITION_RULES.detailMap[normalizedMessage];
      if (transitionByMessage) {
        addRow(entry.at, transitionByMessage, entry.message || null);
      }
    }
    if (payload.blocked && (payload.blocked.stop_reason_code === '${REASON_CODES.operatorNoProgressRedispatchBlocked}' || payload.blocked.stop_reason_code === '${REASON_CODES.awaitingHumanReviewScopeIncomplete}')) {
      addRow('n/a', 'completion_gate_blocked', payload.blocked.stop_reason_detail || null);
    }
    return rows.sort(function (a, b) {
      const atA = Date.parse(a.at);
      const atB = Date.parse(b.at);
      if (Number.isFinite(atA) && Number.isFinite(atB)) {
        return atA - atB;
      }
      if (Number.isFinite(atA)) {
        return -1;
      }
      if (Number.isFinite(atB)) {
        return 1;
      }
      return a.label.localeCompare(b.label);
    });
  }

  function renderThroughput(payload) {
    if (!payload || !payload.throughput) {
      elements.throughputOutput.textContent = 'No throughput samples yet.';
      return;
    }

    const throughput = payload.throughput;
    const sparkline = Array.isArray(throughput.sparkline_10m) ? throughput.sparkline_10m : [];
    elements.throughputOutput.textContent = JSON.stringify(
      {
        current_tps: throughput.current_tps,
        avg_tps_60s: throughput.avg_tps_60s,
        sample_count: throughput.sample_count,
        window_seconds: throughput.window_seconds,
        sparkline_10m: sparkline
      },
      null,
      2
    );
  }

  function renderRuntimeResolution(runtimeResolution) {
    if (!runtimeResolution) {
      elements.runtimeResolutionOutput.textContent = 'Runtime resolution unavailable.';
      return;
    }

    elements.runtimeResolutionOutput.textContent = formatCanonicalJsonBlock('Runtime Resolution JSON', runtimeResolution);
  }

  function renderRuntimeEvents(payload) {
    const events = Array.isArray(payload && payload.recent_runtime_events) ? payload.recent_runtime_events : [];
    const filtered = events.filter(function (entry) {
      if (state.filter.eventFeedSeverity === 'all') {
        return true;
      }
      return entry && entry.severity === state.filter.eventFeedSeverity;
    });

    if (!filtered.length) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'No runtime events.';
      elements.runtimeEventsList.replaceChildren(empty);
      return;
    }

    const nodes = filtered.map(function (entry) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = '[' + (entry.severity || 'info') + '] ' + (entry.event || 'unknown');
      const meta = document.createElement('span');
      const issue = entry.issue_identifier ? ' • issue ' + entry.issue_identifier : '';
      const session = entry.session_id ? ' • session ' + entry.session_id : '';
      const detail = entry.detail ? ' • ' + entry.detail : '';
      meta.textContent = formatDate(entry.at) + issue + session + detail;
      item.append(title, meta);
      return item;
    });

    elements.runtimeEventsList.replaceChildren(...nodes);
  }

  function renderSnapshotError(errorPayload) {
    elements.snapshotErrorPanel.classList.remove('hidden');
    elements.snapshotErrorMessage.textContent =
      (errorPayload && errorPayload.code ? String(errorPayload.code) + ': ' : '') +
      (errorPayload && errorPayload.message ? String(errorPayload.message) : 'Snapshot unavailable.');
    if (!state.lastGoodPayload) {
      elements.kpiGrid.replaceChildren();
      elements.rateLimits.textContent = 'n/a';
      const emptyRunningRow = document.createElement('tr');
      const runningCell = document.createElement('td');
      runningCell.colSpan = 10;
      runningCell.className = 'muted';
      runningCell.textContent = 'No running issues while snapshot is unavailable.';
      emptyRunningRow.appendChild(runningCell);
      elements.runningRows.replaceChildren(emptyRunningRow);

      const emptyRetryRow = document.createElement('tr');
      const retryCell = document.createElement('td');
      retryCell.colSpan = 10;
      retryCell.className = 'muted';
      retryCell.textContent = 'No retry data while snapshot is unavailable.';
      emptyRetryRow.appendChild(retryCell);
      elements.retryRows.replaceChildren(emptyRetryRow);

      const emptyBlockedRow = document.createElement('tr');
      const blockedCell = document.createElement('td');
      blockedCell.colSpan = 8;
      blockedCell.className = 'muted';
      blockedCell.textContent = 'No blocked-input data while snapshot is unavailable.';
      emptyBlockedRow.appendChild(blockedCell);
      elements.blockedRows.replaceChildren(emptyBlockedRow);
      const emptyStopped = document.createElement('p');
      emptyStopped.className = 'muted';
      emptyStopped.textContent = 'No stopped-run recovery data while snapshot is unavailable.';
      elements.stoppedRunRecoveryList.replaceChildren(emptyStopped);
      return;
    }

    // Keep stale-but-last-known-good data visible while snapshot fetch is degraded.
    renderOverview(state.lastGoodPayload);
    renderThroughput(state.lastGoodPayload);
    renderRunning(state.lastGoodPayload);
    renderRetry(state.lastGoodPayload);
    renderBlocked(state.lastGoodPayload);
    renderStoppedRunRecovery(state.lastGoodPayload);
    renderRuntimeEvents(state.lastGoodPayload);
  }

  function clearSnapshotError() {
    elements.snapshotErrorPanel.classList.add('hidden');
    elements.snapshotErrorMessage.textContent = 'Snapshot unavailable.';
  }

`;
}
