import { DASHBOARD_CONFIG } from './config';
import { elements, resolveDashboardElements, setDashboardElements } from './dom';
import { state } from './state';
import { connectStream, loadDiagnostics, loadStateViaPoll, loadUiState, refreshNow, scheduleStateSave, setConnectionStatus, setRefreshStatus, updateRuntimeClock } from './connection';
import { renderRunning, renderRetry, renderBlocked } from './issues';
import { loadIssue } from './issue-detail';
import { renderRuntimeEvents } from './runtime';
import { loadStoppedRunRecovery } from './stopped-runs';
import { loadProjectHistory } from './project-history';
import { applyRuntimeUpdate, enterDrainMode, exitDrainMode, prepareRuntimeUpdate, requestDrainSafeShutdown, waitForDrainQuiescence } from './operator-actions';

export function wireEvents() {
    elements.refreshButton.addEventListener('click', function () {
      void refreshNow();
    });

    if (typeof window.addEventListener === 'function') {
      window.addEventListener('symphony:constellation-issue', function (event: any) {
        const identifier = String(event.detail && event.detail.identifier ? event.detail.identifier : '').trim();
        if (!identifier) {
          return;
        }
        elements.issueInput.value = identifier;
        state.selectedIssue = identifier;
        state.suppressIssuePanelToggleLoad = true;
        elements.issuePanel.open = true;
        if (document.body && document.body.classList) {
          document.body.classList.add('constellation-more-open');
        }
        void loadIssue(identifier);
        elements.issuePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        scheduleStateSave();
      });
    }

    elements.issueLoad.addEventListener('click', function () {
      void loadIssue(elements.issueInput.value);
    });

    if (elements.stoppedRunRecoveryLoad) {
      elements.stoppedRunRecoveryLoad.addEventListener('click', function () {
        void loadStoppedRunRecovery();
      });
    }

    if (elements.drainEnterButton) {
      elements.drainEnterButton.addEventListener('click', function () {
        void enterDrainMode();
      });
    }

    if (elements.drainExitButton) {
      elements.drainExitButton.addEventListener('click', function () {
        void exitDrainMode();
      });
    }

    if (elements.drainWaitButton) {
      elements.drainWaitButton.addEventListener('click', function () {
        void waitForDrainQuiescence();
      });
    }

    if (elements.drainShutdownButton) {
      elements.drainShutdownButton.addEventListener('click', function () {
        void requestDrainSafeShutdown();
      });
    }

    [
      elements.runtimeUpdatePrepareButton,
      elements.runtimeUpdatePreparePanelButton
    ].filter(Boolean).forEach(function (button: any) {
      button.addEventListener('click', function () {
        void prepareRuntimeUpdate();
      });
    });

    [
      elements.runtimeUpdateApplyButton,
      elements.runtimeUpdateApplyPanelButton
    ].filter(Boolean).forEach(function (button: any) {
      button.addEventListener('click', function () {
        void applyRuntimeUpdate();
      });
    });

    elements.projectHistoryLoad.addEventListener('click', function () {
      void loadProjectHistory(elements.projectHistoryProjectKey.value);
    });

    elements.projectHistoryProjectKey.addEventListener('keydown', function (event: any) {
      if (event.key === 'Enter') {
        void loadProjectHistory(elements.projectHistoryProjectKey.value);
      }
    });

    elements.issueInput.addEventListener('keydown', function (event: any) {
      if (event.key === 'Enter') {
        void loadIssue(elements.issueInput.value);
      }
    });

    elements.issueOpenJson.addEventListener('click', function () {
      const identifier = (elements.issueInput.value || state.selectedIssue || '').trim();
      if (!identifier) {
        setRefreshStatus('Provide an issue identifier first', true);
        return;
      }
      window.open('/api/v1/' + encodeURIComponent(identifier), '_blank', 'noopener');
    });

    elements.runningFilter.addEventListener('input', function (event: any) {
      state.filter.query = event.target && event.target.value ? event.target.value : '';
      if (state.payload) {
        renderRunning(state.payload);
        renderRetry(state.payload);
        renderBlocked(state.payload);
      }
      scheduleStateSave();
    });

    elements.statusFilter.addEventListener('change', function (event: any) {
      state.filter.status = event.target && event.target.value ? event.target.value : 'all';
      if (state.filter.status !== 'blocked') {
        state.filter.blockedReason = 'all';
      }
      if (state.payload) {
        renderRunning(state.payload);
        renderRetry(state.payload);
        renderBlocked(state.payload);
      }
      scheduleStateSave();
    });

    elements.eventFeedFilter.addEventListener('change', function (event: any) {
      state.filter.eventFeedSeverity = event.target && event.target.value ? event.target.value : 'all';
      if (state.payload) {
        renderRuntimeEvents(state.payload);
      }
      scheduleStateSave();
    });

    elements.conversationRoleFilter.addEventListener('change', function (event: any) {
      state.filter.conversationRole = event.target && event.target.value ? event.target.value : 'all';
      if (state.selectedIssue && elements.issuePanel.open) {
        void loadIssue(state.selectedIssue, { openPanel: false });
      }
      scheduleStateSave();
    });

    elements.conversationDensity.addEventListener('change', function (event: any) {
      state.filter.conversationDensity = event.target && event.target.value ? event.target.value : 'comfortable';
      if (state.selectedIssue && elements.issuePanel.open) {
        void loadIssue(state.selectedIssue, { openPanel: false });
      }
      scheduleStateSave();
    });

    elements.issuePanel.addEventListener('toggle', function () {
      if (state.suppressIssuePanelToggleLoad) {
        state.suppressIssuePanelToggleLoad = false;
        scheduleStateSave();
        return;
      }
      if (elements.issuePanel.open && state.selectedIssue) {
        void loadIssue(state.selectedIssue, { openPanel: false });
      }
      scheduleStateSave();
    });

    elements.throughputPanel.addEventListener('toggle', function () {
      state.panels.throughputOpen = !!elements.throughputPanel.open;
      scheduleStateSave();
    });

    elements.runtimeEventsPanel.addEventListener('toggle', function () {
      state.panels.runtimeEventsOpen = !!elements.runtimeEventsPanel.open;
      scheduleStateSave();
    });

    document.addEventListener('keydown', function (event: any) {
      if (event.key === '/' && document.activeElement !== elements.runningFilter) {
        event.preventDefault();
        elements.runningFilter.focus();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void refreshNow();
      }
    });
  }

export function startDashboardClient() {
  setDashboardElements(resolveDashboardElements(document));
  wireEvents();
  void loadUiState();
  void loadDiagnostics();
  if (DASHBOARD_CONFIG.dashboard_enabled) {
    void loadStateViaPoll();
    connectStream();
    state.runtimeTicker = setInterval(updateRuntimeClock, DASHBOARD_CONFIG.render_interval_ms);
  } else {
    setConnectionStatus('offline', 'Dashboard refresh disabled by configuration');
    void loadStateViaPoll();
  }
}
