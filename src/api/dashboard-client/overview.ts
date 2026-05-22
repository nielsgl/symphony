import { OPERATOR_TRANSITION_RULES } from './config';
import { elements } from './dom';
import { state } from './state';
import { formatCanonicalJsonBlock, formatDate, formatElapsedMs, formatNumber, getActionRequiredLabel, isActionRequiredCode, formatOverviewTokenValue } from './formatting';
import { renderRunning, renderRetry, renderBlocked } from './issues';

const DRAIN_BLOCKER_LABELS: Record<string, string> = {
  active_worker: 'Active workers',
  live_codex_app_server_process: 'Codex app servers',
  pending_retry: 'Pending retries',
  in_flight_tracker_write: 'Tracker writes',
  persistence_history_write: 'Persistence/history writes',
  unknown_degraded_blocker_source_health: 'Unknown/degraded source health',
  stale_runtime: 'Stale runtime',
  unknown_current_build_identity: 'Unknown current build identity'
};

const DRAIN_BLOCKER_ORDER = [
  'active_worker',
  'live_codex_app_server_process',
  'pending_retry',
  'in_flight_tracker_write',
  'persistence_history_write',
  'unknown_degraded_blocker_source_health',
  'stale_runtime',
  'unknown_current_build_identity'
];

export function createMetricCard(label: any, value: any) {
    const card = document.createElement('article');
    card.className = 'kpi-card';
    const title = document.createElement('h3');
    title.textContent = label;
    const number = document.createElement('p');
    number.textContent = value;
    card.append(title, number);
    return card;
  }

export function computeDisplayRuntimeSeconds(payload: any) {
    if (!payload || !payload.codex_totals) {
      return 0;
    }
    const base = Number(payload.codex_totals.seconds_running) || 0;
    const generatedAtMs = Date.parse(payload.generated_at || '');
    if (!Number.isFinite(generatedAtMs)) {
      return base;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - generatedAtMs) / 1000));
    return base + elapsed;
  }

export function renderOverview(payload: any) {
    const splitUnavailable = payload.codex_totals && payload.codex_totals.token_split_status === 'aggregate_only';
    const quiescence = payload.quiescence || { safe_to_shutdown: true, blocker_counts: {}, blockers: [] };
    const drainBlockerCount = Object.values(quiescence.blocker_counts || {}).reduce(function (total: number, value: any) {
      return total + (Number(value) || 0);
    }, 0);
    elements.kpiGrid.replaceChildren(
      createMetricCard('Safe To Shutdown', quiescence.safe_to_shutdown ? 'Yes' : 'No'),
      createMetricCard('Drain Blockers', formatNumber(drainBlockerCount)),
      createMetricCard('Running', formatNumber(payload.counts.running)),
      createMetricCard('Retrying', formatNumber(payload.counts.retrying)),
      createMetricCard('Blocked', formatNumber(payload.counts.blocked)),
      createMetricCard('Stopped', formatNumber(payload.counts.stopped || 0)),
      createMetricCard('Stalled Waiting', formatNumber(payload.counts.running_stalled_waiting_count || 0)),
      createMetricCard('Awaiting Input', formatNumber(payload.counts.running_awaiting_input_count || 0)),
      createMetricCard('Total Tokens', formatOverviewTokenValue(payload, 'total_tokens', splitUnavailable)),
      createMetricCard('Input Tokens', formatOverviewTokenValue(payload, 'input_tokens', splitUnavailable)),
      createMetricCard('Output Tokens', formatOverviewTokenValue(payload, 'output_tokens', splitUnavailable)),
      createMetricCard('Cached Input Tokens', formatOverviewTokenValue(payload, 'cached_input_tokens', splitUnavailable)),
      createMetricCard('Reasoning Output Tokens', formatOverviewTokenValue(payload, 'reasoning_output_tokens', splitUnavailable)),
      createMetricCard('Max Context Window', formatOverviewTokenValue(payload, 'model_context_window', splitUnavailable)),
      createMetricCard('Runtime Seconds', formatNumber(computeDisplayRuntimeSeconds(payload)))
    );

    const failed = payload.health.dispatch_validation === 'failed';
    elements.healthMessage.className = failed ? 'health health-failed' : 'health health-ok';
    const drainMode = payload.drain_mode || { active: false };
    const drainStatus = drainMode.active
      ? 'Drain Mode: active, ' + (quiescence.safe_to_shutdown ? 'restart safe' : 'restart blocked')
      : 'Drain Mode: inactive';
    elements.healthMessage.textContent = 'Dispatch validation: ' + payload.health.dispatch_validation + ' • ' + drainStatus;
    const blockerDetail =
      quiescence.blockers && quiescence.blockers.length
        ? quiescence.blockers.map(function (blocker: any) {
            return blocker.detail;
          }).join(' • ')
        : '';
    elements.lastError.textContent = [
      payload.health.last_error ? 'Last error: ' + payload.health.last_error : '',
      blockerDetail ? 'Quiescence blockers: ' + blockerDetail : ''
    ].filter(Boolean).join(' • ');
    renderRuntimeIdentityWarning(payload.runtime_identity || null);
    renderRuntimeUpdate(payload.runtime_update || null, payload);
    renderDrainModeWorkflow(payload);
    renderRetryStatusSummary(payload);

    const rateLimits = payload.rate_limits;
    elements.rateLimits.textContent = rateLimits ? JSON.stringify(rateLimits, null, 2) : 'No rate limits reported.';
  }

function formatRuntimeUpdateLabel(value: any) {
    return String(value || 'unknown').replace(/_/g, ' ');
  }

function isActionableRuntimeUpdate(readiness: any) {
    return !!readiness && [
      'local_checkout_behind',
      'remote_update_available',
      'runtime_stale',
      'source_changed_build_not_updated'
    ].includes(readiness.state) && !(readiness.refusal_reasons && readiness.refusal_reasons.length > 0);
  }

function updateRuntimeUpdateButtons(readiness: any, payload: any) {
    const quiescence = payload && payload.quiescence ? payload.quiescence : { safe_to_shutdown: false };
    const drainMode = payload && payload.drain_mode ? payload.drain_mode : { active: false };
    const actionable = isActionableRuntimeUpdate(readiness);
    const prepared = readiness && readiness.prepared === true;
    const applyReady = readiness && readiness.apply_ready === true;
    const prepareDisabled = !actionable || prepared;
    const applyDisabled = !actionable || !applyReady || !drainMode.active || !quiescence.safe_to_shutdown;
    [
      elements.runtimeUpdatePrepareButton,
      elements.runtimeUpdatePreparePanelButton
    ].filter(Boolean).forEach(function (button: any) {
      button.disabled = prepareDisabled;
    });
    [
      elements.runtimeUpdateApplyButton,
      elements.runtimeUpdateApplyPanelButton
    ].filter(Boolean).forEach(function (button: any) {
      button.disabled = applyDisabled;
    });
  }

export function renderRuntimeUpdate(readiness: any, payload: any) {
    if (!elements.runtimeUpdatePanel || !elements.runtimeUpdateState || !elements.runtimeUpdateDetails) {
      return;
    }
    updateRuntimeUpdateButtons(readiness, payload);
    if (!readiness) {
      if (elements.runtimeUpdateBanner) {
        elements.runtimeUpdateBanner.classList.add('hidden');
      }
      elements.runtimeUpdateState.textContent = 'Runtime update readiness unavailable';
      elements.runtimeUpdateRecommendation.textContent = 'The local runtime update detector is not configured.';
      elements.runtimeUpdateDetails.textContent = 'Runtime update details unavailable.';
      return;
    }

    const local = readiness.local_checkout || {};
    const remote = readiness.fetched_remote || {};
    const counts = readiness.ahead_behind || {};
    const fetch = readiness.last_fetch || {};
    const summaryParts = [
      'state ' + formatRuntimeUpdateLabel(readiness.state),
      'branch ' + (local.branch || 'unknown') + ' -> ' + (remote.remote || 'remote') + '/' + (remote.base_ref || 'unknown'),
      'ahead ' + (counts.ahead === null || counts.ahead === undefined ? 'unknown' : counts.ahead),
      'behind ' + (counts.behind === null || counts.behind === undefined ? 'unknown' : counts.behind),
      'fetch ' + (fetch.result || 'unknown')
    ];

    if (readiness.attention_required) {
      elements.runtimeUpdateBanner.classList.remove('hidden');
      elements.runtimeUpdateTitle.textContent =
        readiness.state === 'runtime_stale' ? 'Runtime restart required' : 'Runtime update available';
      elements.runtimeUpdateSummary.textContent = summaryParts.join(' • ');
    } else {
      elements.runtimeUpdateBanner.classList.add('hidden');
      elements.runtimeUpdateSummary.textContent = '';
    }

    elements.runtimeUpdateState.textContent = formatRuntimeUpdateLabel(readiness.state);
    elements.runtimeUpdateRecommendation.textContent = [
      'Recommended action: ' + formatRuntimeUpdateLabel(readiness.recommended_action),
      readiness.drain_required ? 'Drain Mode is required before applying.' : 'Drain Mode is not required.',
      readiness.refusal_reasons && readiness.refusal_reasons.length ? 'Refusal: ' + readiness.refusal_reasons.join(', ') : ''
    ].filter(Boolean).join(' ');
    elements.runtimeUpdateDetails.textContent = formatCanonicalJsonBlock('Runtime Update JSON', readiness);
  }

export function renderDrainModeWorkflow(payload: any) {
    if (!elements.drainModeSummary || !elements.drainModeBoundary || !elements.drainBlockersList) {
      return;
    }
    const drainMode = payload.drain_mode || { active: false };
    const quiescence = payload.quiescence || { safe_to_shutdown: true, blocker_counts: {}, blockers: [] };
    const active = !!drainMode.active;
    const safeToShutdown = !!quiescence.safe_to_shutdown;
    const blockers = Array.isArray(quiescence.blockers) ? quiescence.blockers : [];
    const blockerDetails = blockers
      .map(function (blocker: any) {
        return blocker && blocker.detail ? blocker.detail : '';
      })
      .filter(Boolean);
    const totalBlockers = DRAIN_BLOCKER_ORDER.reduce(function (total, category) {
      return total + (Number(quiescence.blocker_counts && quiescence.blocker_counts[category]) || 0);
    }, 0);

    elements.drainModeSummary.textContent = active
      ? 'Drain Mode active' + (drainMode.reason ? ': ' + drainMode.reason : '')
      : 'Drain Mode inactive';
    elements.drainModeBoundary.className = safeToShutdown ? 'drain-boundary drain-boundary-safe' : 'drain-boundary drain-boundary-blocked';
    if (safeToShutdown) {
      elements.drainModeBoundary.textContent = active
        ? 'Shutdown/restart is safe: no quiescence blockers are present.'
        : 'Restart safety is clear, but Drain Mode is not active.';
    } else {
      elements.drainModeBoundary.textContent =
        'Restart is not safe yet: ' +
        (blockerDetails.length ? blockerDetails.join(' • ') : totalBlockers + ' quiescence blockers remain.');
    }

    const warning = payload.runtime_identity && payload.runtime_identity.health_warning;
    const metaParts = [];
    if (drainMode.entered_at) {
      metaParts.push('Entered ' + formatDate(drainMode.entered_at));
    }
    if (drainMode.updated_at) {
      metaParts.push('Updated ' + formatDate(drainMode.updated_at));
    }
    if (warning && warning.code === 'stale_runtime_build') {
      metaParts.push('Dispatch is unsafe because this runtime is stale; Drain Mode shows when restart is safe.');
    } else if (warning && warning.code === 'unknown_current_build_identity') {
      metaParts.push('Dispatch is unsafe because current build identity is unknown; Drain Mode shows when restart is safe.');
    } else {
      metaParts.push(active ? 'New dispatch is stopped while Drain Mode is active.' : 'Use Drain Mode before planned runtime restarts.');
    }
    elements.drainModeMeta.textContent = metaParts.join(' • ');

    const countByCategory = quiescence.blocker_counts || {};
    const detailByCategory = blockers.reduce(function (acc: Record<string, string>, blocker: any) {
      if (blocker && blocker.category && blocker.detail) {
        acc[blocker.category] = blocker.detail;
      }
      return acc;
    }, {});
    const nodes = DRAIN_BLOCKER_ORDER.map(function (category) {
      const count = Number(countByCategory[category]) || 0;
      const item = document.createElement('div');
      item.className = 'drain-blocker-item ' + (count > 0 ? 'drain-blocker-active' : 'drain-blocker-clear');
      const label = document.createElement('strong');
      label.textContent = DRAIN_BLOCKER_LABELS[category] + ' ' + formatNumber(count);
      const detail = document.createElement('span');
      detail.textContent = count > 0 ? (detailByCategory[category] || 'Blocking safe restart') : 'Clear';
      item.append(label, detail);
      return item;
    });
    elements.drainBlockersList.replaceChildren(...nodes);

    if (elements.drainEnterButton) {
      elements.drainEnterButton.disabled = active;
    }
    if (elements.drainExitButton) {
      elements.drainExitButton.disabled = !active || !safeToShutdown;
    }
    if (elements.drainWaitButton) {
      elements.drainWaitButton.disabled = !active || safeToShutdown;
    }
    if (elements.drainShutdownButton) {
      elements.drainShutdownButton.disabled = !active || !safeToShutdown;
    }
  }

export function renderRuntimeIdentityWarning(runtimeIdentity: any) {
    if (!elements.runtimeStaleBanner || !elements.runtimeStaleTitle || !elements.runtimeStaleSummary) {
      return;
    }
    const warning = runtimeIdentity && runtimeIdentity.health_warning;
    if (!warning) {
      elements.runtimeStaleBanner.classList.add('hidden');
      elements.runtimeStaleTitle.textContent = 'Runtime Build Warning';
      elements.runtimeStaleSummary.textContent = '';
      return;
    }
    elements.runtimeStaleBanner.classList.remove('hidden');
    elements.runtimeStaleTitle.textContent =
      warning.code === 'unknown_current_build_identity' ? 'Runtime build identity unknown' : 'Runtime build is stale';
    const running = runtimeIdentity.running_build || {};
    const current = runtimeIdentity.current_build || {};
    const processStarted = runtimeIdentity.process_started_at || runtimeIdentity.process_started_at_ms || null;
    const currentLabel = current.identity || current.commit_sha || 'unknown';
    elements.runtimeStaleSummary.textContent = [
      warning.message,
      'Running build ' + (running.identity || running.commit_sha || 'unknown'),
      currentLabel === 'unknown' ? 'Current build unknown' : 'Current build ' + currentLabel,
      'Process started ' + formatDate(processStarted),
      warning.recommended_action
    ].join(' • ');
  }

export function renderRetryStatusSummary(payload: any) {
    const entries =
      payload.retry_status && Array.isArray(payload.retry_status.entries)
        ? payload.retry_status.entries
        : Array.isArray(payload.retrying)
          ? payload.retrying.map(function (entry: any) {
              const cause = entry.retry_cause || {};
              return {
                issue_identifier: entry.issue_identifier,
                attempt: entry.attempt,
                due_at: entry.due_at,
                due_state: entry.due_state || 'pending',
                overdue_ms: entry.overdue_ms || null,
                retry_wait_ms: entry.retry_wait_ms || null,
                reason_code: cause.reason_code || entry.stop_reason_code || null,
                detail: cause.detail || entry.stop_reason_detail || entry.error || null,
                operator_detail: cause.operator_detail || null,
                headline: cause.headline || (entry.operator_explainer_hint && entry.operator_explainer_hint.headline) || 'Run is waiting to retry',
                expected_transition: cause.expected_transition || null,
                last_phase: cause.last_phase || entry.last_phase || null
              };
            })
          : [];
    if (!entries.length) {
      elements.retryStatusSummary.classList.add('hidden');
      elements.retryStatusSummary.replaceChildren();
      return;
    }

    const header = document.createElement('div');
    header.className = 'retry-status-header';
    const overdueCount = entries.filter(function (entry: any) {
      return entry.due_state === 'overdue';
    }).length;
    header.textContent =
      overdueCount > 0
        ? overdueCount + ' overdue ' + (overdueCount === 1 ? 'retry needs' : 'retries need') + ' attention'
        : entries.length + ' retry' + (entries.length === 1 ? '' : 'ies') + ' scheduled';

    const list = document.createElement('div');
    list.className = 'retry-status-list';
    entries.slice(0, 4).forEach(function (entry: any) {
      const item = document.createElement('div');
      item.className = 'retry-status-item ' + (entry.due_state === 'overdue' ? 'overdue' : 'pending');

      const title = document.createElement('div');
      title.className = 'retry-status-title';
      const issue = document.createElement('strong');
      issue.textContent = entry.issue_identifier || 'unknown issue';
      const statePill = document.createElement('span');
      statePill.className = 'status-pill ' + (entry.due_state === 'overdue' ? 'failed' : 'pending');
      statePill.textContent =
        entry.due_state === 'overdue'
          ? 'Overdue ' + formatElapsedMs(entry.overdue_ms || 0)
          : 'Retry due ' + formatDate(entry.due_at);
      title.append(issue, statePill);

      const reason = document.createElement('div');
      reason.className = 'retry-status-reason';
      reason.textContent =
        (entry.reason_code || 'unknown_reason') +
        ' - ' +
        (entry.operator_detail || entry.detail || entry.headline || 'No retry detail available');

      const meta = document.createElement('div');
      meta.className = 'muted';
      const parts = [];
      if (entry.last_phase) {
        parts.push('Last phase: ' + entry.last_phase);
      }
      if (entry.detail && entry.detail !== entry.operator_detail) {
        parts.push(entry.detail);
      }
      if (entry.expected_transition) {
        parts.push(entry.expected_transition);
      }
      meta.textContent = parts.join(' • ');

      item.append(title, reason, meta);
      list.append(item);
    });

    elements.retryStatusSummary.classList.remove('hidden');
    elements.retryStatusSummary.replaceChildren(header, list);
  }

export function renderActionRequiredBanner(payload: any) {
    const blockedEntries = Array.isArray(payload && payload.blocked) ? payload.blocked : [];
    const grouped: Record<string, number> = blockedEntries.reduce(function (acc: Record<string, number>, entry: any) {
      if (!isActionRequiredCode(entry.stop_reason_code)) {
        return acc;
      }
      acc[entry.stop_reason_code] = (acc[entry.stop_reason_code] || 0) + 1;
      return acc;
    }, {});
    const groupedEntries = Object.entries(grouped);
    if (!groupedEntries.length) {
      elements.actionRequiredBanner.classList.add('hidden');
      elements.actionRequiredSummary.textContent = '';
      elements.actionRequiredGroups.replaceChildren();
      return;
    }

    const total = groupedEntries.reduce(function (sum: any, entry: any) {
      const count = entry[1];
      return sum + count;
    }, 0);
    elements.actionRequiredBanner.classList.remove('hidden');
    elements.actionRequiredSummary.textContent = total + ' blocked run' + (total === 1 ? '' : 's') + ' need operator action.';

    const groupNodes = groupedEntries.map(function (entry: any) {
      const code = entry[0];
      const count = entry[1];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost-button reason-chip';
      button.textContent = getActionRequiredLabel(code) + ' (' + count + ')';
      button.title = 'Filter blocked rows for ' + getActionRequiredLabel(code);
      button.addEventListener('click', function () {
        state.filter.status = 'blocked';
        state.filter.blockedReason = code;
        elements.statusFilter.value = 'blocked';
        if (state.payload) {
          renderRunning(state.payload);
          renderRetry(state.payload);
          renderBlocked(state.payload);
        }
      });
      return button;
    });
    elements.actionRequiredGroups.replaceChildren(...groupNodes);
  }

export function renderApiDegradedBanner(payload: any) {
    if (!payload || !payload.api_degraded_mode) {
      elements.apiDegradedBanner.classList.add('hidden');
      elements.apiDegradedSummary.textContent = '';
      return;
    }
    const routes = Array.isArray(payload.api_degraded_routes) ? payload.api_degraded_routes.join(', ') : 'n/a';
    elements.apiDegradedBanner.classList.remove('hidden');
    elements.apiDegradedSummary.textContent =
      (payload.api_degraded_reason_code || 'unknown') + ' • fallback routes: ' + routes;
  }

export function describeTransition(transition: any) {
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

export function deriveOperatorTransitionRows(issueId: any, payload: any) {
    const rows: any[] = [];
    const seen = new Set();
    function addRow(at: any, transition: any, detail: any) {
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
    return rows.sort(function (a: any, b: any) {
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
