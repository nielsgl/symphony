import { ACTION_REQUIRED_REASON_LABELS } from '../dashboard-view-model';
import type { DashboardClientConfig } from '../dashboard-assets/types';

export interface DashboardClientConstants {
  safeConfig: {
    dashboard_enabled: boolean;
    refresh_ms: number;
    render_interval_ms: number;
    phase_stale_warn_ms: number;
  };
  actionRequiredReasonLabels: Record<string, string>;
  operatorTransitionRules: {
    detailMap: Record<string, string>;
    eventMap: Record<string, string>;
  };
}

export const DEFAULT_DASHBOARD_CLIENT_CONFIG: DashboardClientConfig = {
  dashboard_enabled: true,
  refresh_ms: 4000,
  render_interval_ms: 1000
};

export function resolveDashboardClientConstants(config: DashboardClientConfig): DashboardClientConstants {
  const safeConfig = {
    dashboard_enabled: config.dashboard_enabled !== false,
    refresh_ms: Math.max(500, Number(config.refresh_ms) || 4000),
    render_interval_ms: Math.max(250, Number(config.render_interval_ms) || 1000),
    phase_stale_warn_ms: Math.max(1000, Number(config.phase_stale_warn_ms) || 45000)
  };
  const operatorTransitionRules = {
    detailMap: {
      'completion gate blocked redispatch because no progress signal was detected': 'completion_gate_blocked',
      'pr is open but scope is incomplete and no progress signal was detected': 'completion_gate_blocked',
      'respawn circuit breaker opened': 'circuit_breaker_opened',
      'resume accepted': 'resume_accepted',
      'resume rejected': 'resume_rejected',
      'cancel accepted': 'cancel_accepted',
      'cancel rejected': 'cancel_rejected'
    },
    eventMap: {
      'orchestrator.redispatch.completion_gate_blocked': 'completion_gate_blocked',
      'orchestrator.redispatch.circuit_breaker_opened': 'circuit_breaker_opened',
      'orchestration.blocked_input.resumed': 'resume_accepted'
    }
  };

  return { safeConfig, actionRequiredReasonLabels: ACTION_REQUIRED_REASON_LABELS, operatorTransitionRules };
}
