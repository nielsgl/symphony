import { renderBootstrapStartSource, renderBootstrapStartupSource } from './client/bootstrap';
import { DEFAULT_DASHBOARD_CLIENT_CONFIG, resolveDashboardClientConstants } from './client/config';
import { renderConnectionRuntimeSource, renderConnectionSource } from './client/connection';
import { renderFormattingSource } from './client/formatting';
import { renderIssueDetailSource } from './client/issue-detail';
import { renderIssuesSource } from './client/issues';
import { renderOperatorActionsSource } from './client/operator-actions';
import { renderOverviewSource } from './client/overview';
import { renderProjectHistorySource } from './client/project-history';
import { renderRuntimeSource } from './client/runtime';
import { renderStoppedRunsSource } from './client/stopped-runs';
import type { DashboardClientConfig } from './types';

export function renderDashboardClientJs(config: DashboardClientConfig = DEFAULT_DASHBOARD_CLIENT_CONFIG): string {
  const constants = resolveDashboardClientConstants(config);

  return [
    renderBootstrapStartSource(constants),
    renderFormattingSource(),
    renderOverviewSource(),
    renderRuntimeSource(),
    renderIssueDetailSource(),
    renderIssuesSource(),
    renderStoppedRunsSource(),
    renderProjectHistorySource(),
    renderConnectionSource(),
    renderOperatorActionsSource(),
    renderConnectionRuntimeSource(),
    renderBootstrapStartupSource()
  ].join('');
}
