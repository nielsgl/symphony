import type { DashboardClientConfig } from '../dashboard-assets/types';

declare global {
  var __SYMPHONY_DASHBOARD_CONFIG__:
    | {
        dashboard_enabled: boolean;
        refresh_ms: number;
        render_interval_ms: number;
        phase_stale_warn_ms: number;
      }
    | undefined;
  var __SYMPHONY_ACTION_REQUIRED_CODES__: Record<string, string> | undefined;
  var __SYMPHONY_OPERATOR_TRANSITION_RULES__:
    | {
        detailMap: Record<string, string>;
        eventMap: Record<string, string>;
      }
    | undefined;
}

export const DEFAULT_DASHBOARD_CLIENT_CONFIG: DashboardClientConfig = {
  dashboard_enabled: true,
  refresh_ms: 4000,
  render_interval_ms: 1000
};

export const DASHBOARD_CONFIG = globalThis.__SYMPHONY_DASHBOARD_CONFIG__ || {
  dashboard_enabled: true,
  refresh_ms: 4000,
  render_interval_ms: 1000,
  phase_stale_warn_ms: 45000
};
export const ACTION_REQUIRED_CODES = globalThis.__SYMPHONY_ACTION_REQUIRED_CODES__ || {};
export const OPERATOR_TRANSITION_RULES = globalThis.__SYMPHONY_OPERATOR_TRANSITION_RULES__ || { detailMap: {}, eventMap: {} };
