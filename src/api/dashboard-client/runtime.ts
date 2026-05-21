import { elements } from './dom';
import { state } from './state';
import { formatCanonicalJsonBlock, formatDate } from './formatting';
import { renderOverview } from './overview';
import { renderRunning, renderRetry, renderBlocked } from './issues';
import { renderStoppedRunRecovery } from './stopped-runs';

export function renderThroughput(payload: any) {
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

export function renderRuntimeResolution(runtimeResolution: any) {
    if (!runtimeResolution) {
      elements.runtimeResolutionOutput.textContent = 'Runtime resolution unavailable.';
      return;
    }

    elements.runtimeResolutionOutput.textContent = formatCanonicalJsonBlock('Runtime Resolution JSON', runtimeResolution);
  }

export function renderRuntimeEvents(payload: any) {
    const events = Array.isArray(payload && payload.recent_runtime_events) ? payload.recent_runtime_events : [];
    const filtered = events.filter(function (entry: any) {
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

    const nodes = filtered.map(function (entry: any) {
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

export function renderSnapshotError(errorPayload: any) {
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

export function clearSnapshotError() {
    elements.snapshotErrorPanel.classList.add('hidden');
    elements.snapshotErrorMessage.textContent = 'Snapshot unavailable.';
  }
