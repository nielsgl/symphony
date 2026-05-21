import { GENERATED_DASHBOARD_CLIENT_JS } from './generated-client';
import { DEFAULT_DASHBOARD_CLIENT_CONFIG, resolveDashboardClientConstants } from '../dashboard-client/config';
import type { DashboardClientConfig } from './types';

export function renderDashboardClientJs(config: DashboardClientConfig = DEFAULT_DASHBOARD_CLIENT_CONFIG): string {
  const constants = resolveDashboardClientConstants(config);

  return [
    `globalThis.__SYMPHONY_DASHBOARD_CONFIG__ = ${JSON.stringify(constants.safeConfig)};\n`,
    `globalThis.__SYMPHONY_ACTION_REQUIRED_CODES__ = ${JSON.stringify(constants.actionRequiredReasonLabels)};\n`,
    `globalThis.__SYMPHONY_OPERATOR_TRANSITION_RULES__ = ${JSON.stringify(constants.operatorTransitionRules)};\n`,
    GENERATED_DASHBOARD_CLIENT_JS
  ].join('');
}
