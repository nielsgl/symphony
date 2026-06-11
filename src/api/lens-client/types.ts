// Re-declares the Living Agent Lens response shape for the browser bundle.
// The TS bundle is built with esbuild and cannot import server-only modules,
// so we re-declare the contract here. Keep in sync with
// src/api/living-agent-lens-types.ts (the source of truth on the server).

export type LensTransport = 'stream' | 'polling' | 'stale' | 'offline';
export type GravityBand = 'focus' | 'urgent' | 'warning' | 'active' | 'idle';
export type Tone = 'blue' | 'amber' | 'green' | 'red' | 'violet' | 'neutral';
export type EvidenceTone = 'green' | 'amber' | 'red' | 'gray' | 'violet';

export interface LensResponse {
  generated_at: string;
  snapshot_freshness: {
    generated_at_ms: number;
    age_ms: number;
    state: 'fresh' | 'aging' | 'stale';
    transport: LensTransport;
    label: string;
    cadence_seconds: number | null;
  };
  shell: ShellTelemetry;
  queue: GravityIssue[];
  focus: FocusRun | null;
  lens: LensTelemetry | null;
  interlocks: InterlockStep[];
  evidence_path: EvidenceNode[];
  actions: ActionButton[];
  footer: FooterTelemetry;
  missing_capabilities: MissingCapability[];
  api_degraded_mode: boolean;
  api_degraded_reason_code: string | null;
}

export interface TelemetryCell {
  icon: string;
  label: string;
  value: string;
  detail: string | null;
  tone: Tone;
  detail_endpoint: string | null;
}

export interface ShellTelemetry {
  brand: { title: string; subtitle: string };
  orchestrator: TelemetryCell;
  runtime_build: TelemetryCell;
  system_health: TelemetryCell;
  audit: TelemetryCell;
  refresh_pulse: TelemetryCell;
  filters: Array<{ id: string; label: string; count: number; active: boolean }>;
}

export interface GravityIssue {
  issue_id: string;
  issue_identifier: string;
  title: string;
  status_label: string;
  state: 'focus' | 'running' | 'review' | 'retry' | 'blocked' | 'warning' | 'idle';
  glyph: 'focus' | 'running' | 'review' | 'blocked' | 'warning' | 'retry';
  gravity_score: number;
  gravity_band: GravityBand;
  gravity_reasons: Array<{ code: string; label: string; weight: number; evidence_ref: string | null }>;
  recommended_focus_reason: string | null;
  is_focus: boolean;
  detail_endpoint: string;
}

export interface FocusRun {
  issue_id: string;
  issue_identifier: string;
  title: string;
  run_attempt: number;
  thread_id: string | null;
  session_id: string | null;
  workspace_path: string | null;
  branch: string | null;
  pr_links: Array<{ label: string; url: string }>;
  tracker_url: string | null;
  durable_run_key: string | null;
}

export interface LensTelemetry {
  ring_tone: Tone;
  current_message: {
    message_id: string;
    role: string;
    excerpt: string;
    at: string;
    truncated: boolean;
    source_ref: string | null;
  } | null;
  role_stream: {
    window_size: number;
    segments: Array<{ role: string; count: number; tone: Tone }>;
  };
  events: Array<{
    id: string;
    label: string;
    category: string;
    at: string;
    tone: Tone;
    icon: string;
    summary: string;
    evidence_ref: string | null;
    detail_endpoint: string | null;
  }>;
  context_window: {
    visible_messages: number;
    clipped_messages: number;
    redacted_count: number;
    limit: number;
    scan_budget_state: 'ok' | 'exhausted' | 'unknown';
  };
  transcript_confidence: {
    score: number;
    label: string;
    reasons: string[];
  };
  model: { requested: string | null; effective: string | null; reroute_reason: string | null } | null;
}

export interface InterlockStep {
  index: 1 | 2 | 3 | 4;
  id: 'preconditions' | 'intent' | 'preview' | 'receipt';
  title: string;
  subtitle: string;
  tone: Tone;
  state_label: string;
  body: InterlockBody;
}

export type InterlockBody =
  | { kind: 'preconditions'; checks: Array<{ id: string; label: string; ok: boolean; detail: string | null; owner: string | null; evidence_ref: string | null }> }
  | { kind: 'intent'; intent_capsule: string; reason_note_required: boolean; composer_endpoint: string | null }
  | { kind: 'preview'; method: string | null; endpoint: string | null; body_preview: string | null; truncated: boolean }
  | { kind: 'receipt'; lifecycle: string; receipt_id: string | null; at: string | null; result: string | null };

export interface EvidenceNode {
  id: 'thread' | 'transcript' | 'api_snapshot' | 'audit' | 'workspace';
  label: string;
  value: string;
  tone: EvidenceTone;
  detail: string | null;
  open_endpoint: string | null;
  copy_value: string | null;
}

export interface ActionButton {
  id: 'steer' | 'resume' | 'inspect_evidence' | 'export_forensics' | 'drain_wait' | 'more';
  label: string;
  intent_line: string;
  icon: string;
  tone: Tone;
  enabled: boolean;
  disabled_reason: string | null;
  destructive: boolean;
  api_action: unknown;
  last_result: unknown;
  more_items?: Array<{ id: string; label: string; endpoint: string | null; enabled: boolean; disabled_reason: string | null }>;
}

export interface FooterTelemetry {
  operator: string | null;
  snapshot_time: string;
  local_time: string;
  api: TelemetryCell;
  workers: TelemetryCell;
  queues: TelemetryCell;
}

export interface MissingCapability {
  id: string;
  label: string;
  required_for: string;
  severity: 'blocks_action' | 'degrades_observability' | 'visual_only';
  current_fallback: string;
  implementation_hint: string;
}
