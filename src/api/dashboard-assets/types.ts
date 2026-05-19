export interface DashboardClientConfig {
  dashboard_enabled: boolean;
  refresh_ms: number;
  render_interval_ms: number;
  phase_stale_warn_ms?: number;
}
