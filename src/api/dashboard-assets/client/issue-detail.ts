export function renderIssueDetailSource(): string {
  return `  function createStateBadge(stateValue) {
    const badge = document.createElement('span');
    badge.className = 'state-badge';
    const normalized = String(stateValue || '').toLowerCase();
    if (normalized.includes('progress') || normalized.includes('running')) {
      badge.classList.add('state-active');
    } else if (normalized.includes('todo') || normalized.includes('backlog')) {
      badge.classList.add('state-idle');
    } else if (normalized.includes('done') || normalized.includes('closed')) {
      badge.classList.add('state-terminal');
    } else {
      badge.classList.add('state-neutral');
    }
    badge.textContent = stateValue || 'unknown';
    return badge;
  }

  function createProvisioningBadge(label, ok) {
    const badge = document.createElement('span');
    badge.className = 'mini-badge ' + (ok ? 'mini-badge-good' : 'mini-badge-bad');
    badge.textContent = label + ': ' + (ok ? 'yes' : 'no');
    return badge;
  }

  function normalizeActionability(value) {
    const actionability = String(value || 'none');
    return actionability === 'required' || actionability === 'recommended' ? actionability : 'none';
  }

  function createOperatorHintBadge(hint) {
    if (!hint) {
      return null;
    }
    const actionability = normalizeActionability(hint.actionability);
    const badge = document.createElement('span');
    badge.className = 'operator-hint actionability-' + actionability;
    badge.textContent = String(hint.headline || hint.classification || 'Runtime diagnostics');
    badge.title = 'Actionability: ' + actionability + ' • Classification: ' + String(hint.classification || 'unknown');
    return badge;
  }

  function renderIssueExplainer(explainer) {
    if (!explainer) {
      elements.issueExplainerCard.classList.add('hidden');
      return;
    }
    const actionability = normalizeActionability(explainer.actionability);
    elements.issueExplainerCard.className = 'operator-explainer actionability-' + actionability;
    elements.issueExplainerActionability.className = 'status-pill actionability-' + actionability;
    elements.issueExplainerActionability.textContent = actionability;
    elements.issueExplainerHeadline.textContent = explainer.headline || 'Runtime diagnostics unavailable';
    elements.issueExplainerClassification.textContent = explainer.classification || 'unknown';
    elements.issueExplainerReason.textContent =
      (explainer.reason_code || 'n/a') + (explainer.reason_detail ? ' • ' + explainer.reason_detail : '');
    elements.issueExplainerAction.textContent =
      Array.isArray(explainer.recommended_actions) && explainer.recommended_actions.length
        ? explainer.recommended_actions.join('; ')
        : 'No operator action required';
    elements.issueExplainerTransition.textContent = explainer.expected_transition || 'No automatic transition expected';
    elements.issueExplainerVersion.textContent = explainer.version || 'unknown';
    elements.issueExplainerDetail.textContent = explainer.detail || '';
  }

  function appendDefinitionValue(list, label, value) {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = value === null || value === undefined || value === '' ? 'n/a' : String(value);
    wrapper.append(term, definition);
    list.append(wrapper);
  }

  function renderThreadBlockerCard(blocker) {
    elements.threadBlockerCard.replaceChildren();
    if (!blocker) {
      appendDefinitionValue(elements.threadBlockerCard, 'classification', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'reason_code', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'reason_detail', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'time_since_progress', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'recommended_actions', 'No blocker actions reported.');
      appendDefinitionValue(elements.threadBlockerCard, 'expected_auto_transition', 'n/a');
      return;
    }
    appendDefinitionValue(elements.threadBlockerCard, 'classification', blocker.classification);
    appendDefinitionValue(elements.threadBlockerCard, 'reason_code', blocker.reason_code);
    appendDefinitionValue(elements.threadBlockerCard, 'reason_detail', blocker.reason_detail);
    appendDefinitionValue(elements.threadBlockerCard, 'time_since_progress', blocker.time_since_progress);
    if (blocker.missing_tool_output_recovery) {
      const recovery = blocker.missing_tool_output_recovery;
      appendDefinitionValue(elements.threadBlockerCard, 'recovery_headline', recovery.headline);
      appendDefinitionValue(elements.threadBlockerCard, 'recovery_state', recovery.status);
      appendDefinitionValue(elements.threadBlockerCard, 'recovery_next_action', recovery.next_action);
      appendDefinitionValue(elements.threadBlockerCard, 'original_tool', recovery.original_tool_name);
      appendDefinitionValue(elements.threadBlockerCard, 'original_call_id', recovery.original_call_id);
      appendDefinitionValue(elements.threadBlockerCard, 'evidence_source', recovery.evidence_source);
      appendDefinitionValue(elements.threadBlockerCard, 'elapsed_wait_ms', recovery.elapsed_wait_ms);
      appendDefinitionValue(
        elements.threadBlockerCard,
        'active_ownership',
        recovery.active_ownership
          ? [
              'issue ' + (recovery.active_ownership.issue_identifier || recovery.active_ownership.issue_id || 'n/a'),
              'thread ' + (recovery.active_ownership.thread_id || 'n/a'),
              'turn ' + (recovery.active_ownership.turn_id || 'n/a'),
              'session ' + (recovery.active_ownership.session_id || 'n/a'),
              'app_server_owned ' + String(Boolean(recovery.active_ownership.app_server_owned))
            ].join(' | ')
          : 'n/a'
      );
      appendDefinitionValue(
        elements.threadBlockerCard,
        'recovery_lineage',
        [
          'interrupt ' + ((recovery.interrupt_cancel_result && recovery.interrupt_cancel_result.status) || 'n/a'),
          'replacement_thread ' + ((recovery.replacement_turn && recovery.replacement_turn.thread_id) || 'n/a'),
          'replacement_turn ' + ((recovery.replacement_turn && recovery.replacement_turn.turn_id) || 'n/a'),
          'prompt ' + ((recovery.guarded_prompt_dispatch && recovery.guarded_prompt_dispatch.status) || 'n/a'),
          'outcome ' + ((recovery.final_outcome && recovery.final_outcome.result) || 'n/a')
        ].join(' | ')
      );
    }
    appendDefinitionValue(
      elements.threadBlockerCard,
      'recommended_actions',
      Array.isArray(blocker.recommended_actions) ? blocker.recommended_actions.join('; ') : 'n/a'
    );
    appendDefinitionValue(elements.threadBlockerCard, 'expected_auto_transition', blocker.expected_auto_transition);
  }

  function spanLabel(span, kind) {
    if (kind === 'phase') {
      return span.phase || 'phase';
    }
    if (kind === 'tool') {
      return span.tool_name || 'tool';
    }
    return span.reason_code || span.status || 'wait';
  }

  function renderTimelineLane(title, spans, kind) {
    const lane = document.createElement('section');
    lane.className = 'timeline-lane timeline-lane-' + kind;
    const heading = document.createElement('h4');
    heading.textContent = title;
    lane.append(heading);
    const safeSpans = Array.isArray(spans) ? spans : [];
    if (!safeSpans.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No ' + title.toLowerCase() + ' spans.';
      lane.append(empty);
      return lane;
    }
    const list = document.createElement('ul');
    for (const span of safeSpans) {
      const item = document.createElement('li');
      const label = document.createElement('strong');
      const meta = document.createElement('span');
      label.textContent = spanLabel(span, kind);
      meta.textContent =
        ' | started ' +
        formatDate(span.started_at_ms) +
        ' | ended ' +
        (span.ended_at_ms === null || span.ended_at_ms === undefined ? 'open' : formatDate(span.ended_at_ms)) +
        ' | duration ' +
        (span.duration_ms === null || span.duration_ms === undefined ? 'open' : String(span.duration_ms)) +
        ' | status ' +
        (span.status || 'n/a') +
        ' | reason ' +
        (span.reason_code || 'n/a') +
        ' | ' +
        (span.reason_detail || 'n/a');
      item.append(label, meta);
      list.append(item);
    }
    lane.append(list);
    return lane;
  }

  function renderThreadDiagnostics(diagnostics) {
    if (!diagnostics) {
      elements.threadDetail.classList.add('hidden');
      elements.threadRawEvents.textContent = 'Detailed diagnostics are not loaded.';
      return;
    }
    elements.threadDetail.classList.remove('hidden');
    elements.threadTimelineLanes.replaceChildren(
      renderTimelineLane('Phase', diagnostics.phase_spans, 'phase'),
      renderTimelineLane('Tool', diagnostics.tool_spans, 'tool'),
      renderTimelineLane('Wait', diagnostics.wait_spans, 'wait')
    );
    renderThreadBlockerCard(diagnostics.current_blocker || null);
    const warnings = Array.isArray(diagnostics.capability_warnings) ? diagnostics.capability_warnings : [];
    if (!warnings.length) {
      elements.threadCapabilityWarnings.className = 'capability-warnings muted';
      elements.threadCapabilityWarnings.textContent = 'No capability warnings.';
    } else {
      elements.threadCapabilityWarnings.className = 'capability-warnings';
      const list = document.createElement('ul');
      for (const warning of warnings) {
        const item = document.createElement('li');
        item.textContent =
          (warning.reason_code || 'capability_warning') +
          ' | source ' +
          (warning.source_environment || 'n/a') +
          ' | tool ' +
          (warning.attempted_tool_name || 'n/a') +
          ' | call ' +
          (warning.call_id || 'n/a') +
          ' | thread ' +
          (warning.thread_id || 'n/a') +
          ' | turn ' +
          (warning.turn_id || 'n/a') +
          ' | ' +
          (warning.unsupported_capability_message || 'unsupported capability') +
          ' | recovery ' +
          (warning.recommended_recovery_action || 'n/a');
        list.append(item);
      }
      elements.threadCapabilityWarnings.replaceChildren(list);
    }
    const events = Array.isArray(diagnostics.timeline) ? diagnostics.timeline : [];
    elements.threadRawEvents.textContent = events.length
      ? events
          .map(function (event) {
            return (
              formatDate(event.at_ms) +
              ' | ' +
              event.event +
              ' | thread ' +
              (event.thread_id || 'n/a') +
              ' | turn ' +
              (event.turn_id || 'n/a') +
              ' | session ' +
              (event.session_id || 'n/a') +
              ' | reason ' +
              (event.reason_code || 'n/a') +
              ' | ' +
              (event.reason_detail || 'n/a')
            );
          })
          .join('\\n')
      : 'No raw event stream entries.';
  }

  function getDiagnosticSummary(entry) {
    return entry && entry.transcript_tool_call_diagnostic_summary ? entry.transcript_tool_call_diagnostic_summary : null;
  }

  function formatDiagnosticSummary(summary) {
    if (!summary) {
      return 'Summary diagnostics: unavailable';
    }
    const parts = [];
    parts.push(summary.detailed_diagnostics_available ? 'detail available' : 'summary only');
    parts.push(formatNumber(summary.total_count || 0) + ' transcript records');
    if (summary.active_missing_tool_output && summary.active_missing_tool_output.active) {
      parts.push('missing output ' + (summary.active_missing_tool_output.tool_name || summary.active_missing_tool_output.call_id || 'active'));
    }
    if (summary.recovery && summary.recovery.active) {
      parts.push('recovery ' + (summary.recovery.status || 'active'));
    }
    if (summary.newest_observed_at) {
      parts.push('newest ' + formatDate(summary.newest_observed_at));
    }
    return 'Summary diagnostics: ' + parts.join(' | ');
  }

  function formatInputDecisionContext(detail) {
    if (!detail) {
      return null;
    }
    if (detail.includes('input_required_unanswerable')) {
      return 'Input handling: unanswerable schema (manual resume required)';
    }
    if (detail.includes('non_interactive_fallback')) {
      return 'Input handling: non-interactive fallback answer';
    }
    if (detail.includes('approval_option_permissive')) {
      return 'Input handling: permissive approval option selected';
    }
    if (detail.includes('approval_option_exact')) {
      return 'Input handling: exact approval option selected';
    }
    return null;
  }

  function createActionButton(text, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  async function copyText(value) {
    if (!value) {
      setRefreshStatus('No value to copy', true);
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const helper = document.createElement('textarea');
        helper.value = value;
        helper.setAttribute('readonly', 'readonly');
        helper.style.position = 'absolute';
        helper.style.left = '-9999px';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        document.body.removeChild(helper);
      }
      setRefreshStatus('Copied: ' + value, false);
    } catch (error) {
      setRefreshStatus('Copy failed: ' + String(error), true);
    }
  }

`;
}
