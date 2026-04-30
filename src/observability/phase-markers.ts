export const PHASE_SEQUENCE = [
  'dispatch_started',
  'workspace_ready',
  'prompt_sent',
  'codex_session_started',
  'codex_turn_started',
  'planning',
  'implementation',
  'validation',
  'pr_preparation',
  'tracker_update',
  'completed',
  'failed',
  'blocked_input'
] as const;

export type PhaseMarkerName = (typeof PHASE_SEQUENCE)[number];

export interface PhaseMarker {
  at_ms: number;
  phase: PhaseMarkerName;
  detail: string | null;
  attempt: number;
  thread_id?: string | null;
  session_id?: string | null;
}

const PHASE_INDEX = new Map<PhaseMarkerName, number>(PHASE_SEQUENCE.map((phase, index) => [phase, index]));
const TERMINAL_PHASES = new Set<PhaseMarkerName>(['completed', 'failed', 'blocked_input']);

export function isKnownPhaseMarker(phase: string): phase is PhaseMarkerName {
  return PHASE_INDEX.has(phase as PhaseMarkerName);
}

export function phaseMarkerOrder(phase: PhaseMarkerName): number {
  return PHASE_INDEX.get(phase) ?? -1;
}

export function isTerminalPhaseMarker(phase: PhaseMarkerName): boolean {
  return TERMINAL_PHASES.has(phase);
}
