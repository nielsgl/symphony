/**
 * Living Agent Lens view-model contract.
 *
 * Implements the normalized, frontend-ready projection described in
 * docs/analysis/living-agent-lens-ultimate-design-spec.md. The frontend
 * (Notification Gravity queue, Living Agent Lens, Interlock Spine, Evidence
 * Path, Action Dock, Status Footer) consumes this single response shape so
 * each component does not re-derive operational truth from raw /state.
 *
 * `missing_capabilities` is a first-class field: when a section of the UI
 * cannot be backed by a real backend signal yet, the projector emits a
 * structured entry rather than letting the UI invent a green check.
 */

import type {
  ApiAvailableOperatorAction,
  ApiDegradedReasonCode,
  OperatorActionProjection,
  SnapshotFreshnessState
} from './types';

export type LensTransport = 'stream' | 'polling' | 'stale' | 'offline';

export type GravityBand = 'focus' | 'urgent' | 'warning' | 'active' | 'idle';

export type InterlockNodeTone = 'blue' | 'amber' | 'green' | 'red' | 'violet' | 'neutral';

export type EvidenceTone = 'green' | 'amber' | 'red' | 'gray' | 'violet';

export type RefreshTransport = 'stream' | 'polling' | 'stale' | 'offline';

/** Top-level Living Agent Lens response served at `GET /api/v1/living-agent-lens`. */
export interface LivingAgentLensResponse {
  /** ISO timestamp of the projector's source snapshot. */
  generated_at: string;
  /** Freshness/transport facts for the refresh pulse indicator. */
  snapshot_freshness: SnapshotFreshness;
  /** Top telemetry ribbon. */
  shell: ShellTelemetry;
  /** Notification Gravity queue (ordered by gravity_score desc). */
  queue: GravityIssue[];
  /** Currently focused run, or null if no queue entry is selected. */
  focus: FocusRun | null;
  /** Living Agent Lens telemetry for the focused run. */
  lens: LensTelemetry | null;
  /** Interlock Spine cards in order (preconditions, intent, preview, receipt). */
  interlocks: InterlockStep[];
  /** Evidence Path nodes shown beneath the lens. */
  evidence_path: EvidenceNode[];
  /** Action Dock buttons (Steer, Resume, Inspect Evidence, Export Forensics, Drain: Wait, More). */
  actions: OperatorActionButton[];
  /** Status footer cells. */
  footer: FooterTelemetry;
  /** Honest missing-capability markers. UI must surface these in context. */
  missing_capabilities: MissingCapability[];
  /** Pass-through API degradation reason if the underlying snapshot was degraded. */
  api_degraded_mode: boolean;
  api_degraded_reason_code: ApiDegradedReasonCode;
}

export interface SnapshotFreshness {
  generated_at_ms: number;
  age_ms: number;
  state: SnapshotFreshnessState;
  transport: RefreshTransport;
  /** Human label for refresh-pulse cell: "1.2s", "POLLING", "STALE". */
  label: string;
  /** Cadence value rendered next to the oscilloscope line. */
  cadence_seconds: number | null;
}

export interface ShellTelemetry {
  brand: { title: string; subtitle: string };
  orchestrator: TelemetryCell;
  runtime_build: TelemetryCell;
  system_health: TelemetryCell;
  audit: TelemetryCell;
  refresh_pulse: TelemetryCell;
  filters: FilterDescriptor[];
}

export interface TelemetryCell {
  icon: string;
  label: string;
  value: string;
  detail: string | null;
  /** Maps to text + dot/ring color. Never use color alone; provide tone + label. */
  tone: InterlockNodeTone;
  /** Optional source endpoint for click-through. */
  detail_endpoint: string | null;
}

export interface FilterDescriptor {
  id: 'needs_me' | 'stalled' | 'retry_overdue' | 'unsafe_restart' | 'budget_risk' | 'model_rerouted';
  label: string;
  /** Count of issues currently matching. */
  count: number;
  active: boolean;
}

export interface GravityIssue {
  issue_id: string;
  issue_identifier: string;
  title: string;
  status_label: string;
  /** "focus" | "running" | "review" | "retry" | "blocked" | "warning" — drives glyph + color. */
  state: 'focus' | 'running' | 'review' | 'retry' | 'blocked' | 'warning' | 'idle';
  glyph: 'focus' | 'running' | 'review' | 'blocked' | 'warning' | 'retry';
  gravity_score: number;
  gravity_band: GravityBand;
  gravity_reasons: GravityReason[];
  recommended_focus_reason: string | null;
  /** True if this is the row currently driving the lens. */
  is_focus: boolean;
  /** Issue detail endpoint for drilldown. */
  detail_endpoint: string;
}

export interface GravityReason {
  code: string;
  label: string;
  weight: number;
  evidence_ref: string | null;
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
  /** Tracker URL when available. */
  tracker_url: string | null;
  /** Stable durable key for cross-refresh identity. */
  durable_run_key: string | null;
}

export interface LensTelemetry {
  /** Outer ring tone. */
  ring_tone: InterlockNodeTone;
  /** Currently-visible message card. */
  current_message: CurrentMessageCard | null;
  /** Last-N role-stream histogram. */
  role_stream: RoleStream;
  /** Event orbit nodes (terminal, git, linear, build, tests, etc.). */
  events: EventOrbitNode[];
  /** Bounded transcript window stats. */
  context_window: ContextWindowFacts;
  /** Transcript confidence score. */
  transcript_confidence: TranscriptConfidence;
  /** Requested vs. effective model + reroute reason if applicable. */
  model: LensModelFacts | null;
}

export interface CurrentMessageCard {
  message_id: string;
  role: 'assistant' | 'user' | 'tool' | 'system' | 'runtime';
  excerpt: string;
  /** ISO timestamp the message was emitted. */
  at: string;
  truncated: boolean;
  /** Source event / transcript line ref for the inspector. */
  source_ref: string | null;
}

export interface RoleStream {
  window_size: number;
  segments: Array<{ role: 'assistant' | 'tool' | 'user' | 'system' | 'runtime'; count: number; tone: InterlockNodeTone }>;
}

export interface EventOrbitNode {
  id: string;
  label: string;
  category: 'terminal' | 'git' | 'linear' | 'build' | 'tests' | 'runtime' | 'tool';
  at: string;
  tone: InterlockNodeTone;
  icon: string;
  summary: string;
  evidence_ref: string | null;
  detail_endpoint: string | null;
}

export interface ContextWindowFacts {
  visible_messages: number;
  clipped_messages: number;
  redacted_count: number;
  limit: number;
  scan_budget_state: 'ok' | 'exhausted' | 'unknown';
}

export interface TranscriptConfidence {
  score: number;
  label: 'high' | 'medium' | 'low' | 'unavailable';
  reasons: string[];
}

export interface LensModelFacts {
  requested: string | null;
  effective: string | null;
  reroute_reason: string | null;
}

export interface InterlockStep {
  /** 1=preconditions, 2=intent, 3=preview, 4=receipt. */
  index: 1 | 2 | 3 | 4;
  id: 'preconditions' | 'intent' | 'preview' | 'receipt';
  title: string;
  subtitle: string;
  /** Spine node tone — color the rail and the card border. */
  tone: InterlockNodeTone;
  /** State label e.g. "4 / 4 verified". */
  state_label: string;
  body: InterlockBody;
}

export type InterlockBody =
  | { kind: 'preconditions'; checks: PreconditionCheck[] }
  | { kind: 'intent'; intent_capsule: string; reason_note_required: boolean; composer_endpoint: string | null }
  | { kind: 'preview'; method: string | null; endpoint: string | null; body_preview: string | null; truncated: boolean }
  | { kind: 'receipt'; lifecycle: ReceiptLifecycle; receipt_id: string | null; at: string | null; result: string | null };

export interface PreconditionCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Why this check fails or is missing. */
  detail: string | null;
  /** Owner for remediation. */
  owner: string | null;
  evidence_ref: string | null;
}

export type ReceiptLifecycle = 'preview' | 'pending' | 'created' | 'rejected' | 'failed';

export interface EvidenceNode {
  id: 'thread' | 'transcript' | 'api_snapshot' | 'audit' | 'workspace';
  label: string;
  value: string;
  tone: EvidenceTone;
  /** Reason text when amber/red. */
  detail: string | null;
  open_endpoint: string | null;
  copy_value: string | null;
}

export interface OperatorActionButton {
  id: 'steer' | 'resume' | 'inspect_evidence' | 'export_forensics' | 'drain_wait' | 'more';
  label: string;
  intent_line: string;
  icon: string;
  tone: InterlockNodeTone;
  enabled: boolean;
  disabled_reason: string | null;
  destructive: boolean;
  /** Backend action this maps to, when applicable. */
  api_action: ApiAvailableOperatorAction | null;
  /** Latest known operator-action result for this issue/action (lifecycle). */
  last_result: OperatorActionProjection | null;
  /** Secondary menu items when id === 'more'. */
  more_items?: MoreMenuItem[];
}

export interface MoreMenuItem {
  id: string;
  label: string;
  endpoint: string | null;
  enabled: boolean;
  disabled_reason: string | null;
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
  required_for:
    | 'gravity'
    | 'interlock'
    | 'command_preview'
    | 'audit_receipt'
    | 'evidence_path'
    | 'event_orbit'
    | 'forensics'
    | 'project_identity'
    | 'rate_limit'
    | 'validation_ledger'
    | 'transcript_confidence'
    | 'context_window'
    | 'role_stream';
  severity: 'blocks_action' | 'degrades_observability' | 'visual_only';
  current_fallback: string;
  implementation_hint: string;
}
