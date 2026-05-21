export function renderOverviewSource(): string {
  return `  function createMetricCard(label, value) {
    const card = document.createElement('article');
    card.className = 'kpi-card';
    const title = document.createElement('h3');
    title.textContent = label;
    const number = document.createElement('p');
    number.textContent = value;
    card.append(title, number);
    return card;
  }

  function formatTokenDimension(value, unavailableLabel) {
    return typeof value === 'number' ? formatNumber(value) : unavailableLabel;
  }

  function formatOverviewTokenValue(payload, field, splitUnavailable) {
    const codexTotals = payload && payload.codex_totals;
    if (!codexTotals) {
      return 'Unavailable';
    }
    if (splitUnavailable && field !== 'total_tokens' && field !== 'model_context_window') {
      return 'Split unavailable';
    }
    return formatTokenDimension(codexTotals[field], '0');
  }

  function formatTokenBreakdown(tokens, telemetrySource) {
    if (tokens && tokens.token_split_status === 'aggregate_only') {
      return 'Split unavailable' + (telemetrySource ? ' • ' + telemetrySource : '');
    }
    const parts = [
      'In ' + formatNumber(tokens.input_tokens),
      'Out ' + formatNumber(tokens.output_tokens)
    ];
    if (typeof tokens.cached_input_tokens === 'number') {
      parts.push('Cached ' + formatNumber(tokens.cached_input_tokens));
    }
    if (typeof tokens.reasoning_output_tokens === 'number') {
      parts.push('Reasoning ' + formatNumber(tokens.reasoning_output_tokens));
    }
    if (typeof tokens.model_context_window === 'number') {
      parts.push('Context ' + formatNumber(tokens.model_context_window));
    }
    return parts.join(' / ') + (telemetrySource ? ' • ' + telemetrySource : '');
  }

  function computeDisplayRuntimeSeconds(payload) {
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

  function renderOverview(payload) {
    const splitUnavailable = payload.codex_totals && payload.codex_totals.token_split_status === 'aggregate_only';
    elements.kpiGrid.replaceChildren(
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
    elements.healthMessage.textContent = 'Dispatch validation: ' + payload.health.dispatch_validation;
    elements.lastError.textContent = payload.health.last_error ? 'Last error: ' + payload.health.last_error : '';
    renderRetryStatusSummary(payload);

    const rateLimits = payload.rate_limits;
    elements.rateLimits.textContent = rateLimits ? JSON.stringify(rateLimits, null, 2) : 'No rate limits reported.';
  }

  function renderRetryStatusSummary(payload) {
    const entries =
      payload.retry_status && Array.isArray(payload.retry_status.entries)
        ? payload.retry_status.entries
        : Array.isArray(payload.retrying)
          ? payload.retrying.map(function (entry) {
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
    const overdueCount = entries.filter(function (entry) {
      return entry.due_state === 'overdue';
    }).length;
    header.textContent =
      overdueCount > 0
        ? overdueCount + ' overdue ' + (overdueCount === 1 ? 'retry needs' : 'retries need') + ' attention'
        : entries.length + ' retry' + (entries.length === 1 ? '' : 'ies') + ' scheduled';

    const list = document.createElement('div');
    list.className = 'retry-status-list';
    entries.slice(0, 4).forEach(function (entry) {
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

  function renderActionRequiredBanner(payload) {
    const blockedEntries = Array.isArray(payload && payload.blocked) ? payload.blocked : [];
    const grouped = blockedEntries.reduce(function (acc, entry) {
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

    const total = groupedEntries.reduce(function (sum, entry) {
      const count = entry[1];
      return sum + count;
    }, 0);
    elements.actionRequiredBanner.classList.remove('hidden');
    elements.actionRequiredSummary.textContent = total + ' blocked run' + (total === 1 ? '' : 's') + ' need operator action.';

    const groupNodes = groupedEntries.map(function (entry) {
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

  function renderApiDegradedBanner(payload) {
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

`;
}
