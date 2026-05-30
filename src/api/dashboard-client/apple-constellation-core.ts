import { elements } from './dom';

type AgentRole = 'system' | 'user' | 'assistant' | 'tool' | 'runtime';

interface LensEvent {
  label: string;
  detail: string;
  at: string;
  tone: string;
}

interface RoleStream {
  role: AgentRole;
  count: number;
}

interface LensModel {
  identifier: string;
  title: string;
  runLabel: string;
  latestRole: string;
  latestMessage: string;
  latestAt: string;
  threadId: string;
  sessionId: string;
  confidence: number;
  confidenceLabel: string;
  roleStream: RoleStream[];
  events: LensEvent[];
  contextVisible: number;
  contextClipped: number;
  contextPercent: number;
}

const FALLBACK_LENS: LensModel = {
  identifier: 'NIE-300',
  title: 'Chatty',
  runLabel: 'Run Attempt #2',
  latestRole: 'assistant',
  latestMessage: 'Applying bounded payload strategy to snapshot API. Adding windowed transcript pagination and cursor semantics...',
  latestAt: '12:41:28 - now',
  threadId: 'thread_01JX7...',
  sessionId: 'sessions/01JX7/rollout.json',
  confidence: 0.92,
  confidenceLabel: 'high',
  roleStream: [
    { role: 'assistant', count: 6 },
    { role: 'tool', count: 3 },
    { role: 'user', count: 1 },
    { role: 'system', count: 2 }
  ],
  events: [
    { label: 'terminal', detail: 'command stream', at: '12:41:12', tone: 'blue' },
    { label: 'git', detail: 'diff + branch', at: '12:41:05', tone: 'orange' },
    { label: 'Linear', detail: 'ticket sync', at: '12:40:58', tone: 'violet' },
    { label: 'build', detail: 'asset bundle', at: '12:40:41', tone: 'green' },
    { label: 'tests', detail: 'targeted suite', at: '12:40:29', tone: 'cyan' }
  ],
  contextVisible: 120,
  contextClipped: 80,
  contextPercent: 60
};

function cleanText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  const text = cleanText(value);
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(0, maxLength - 3)).trim() + '...';
}

function createElement(tag: string, className: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function setStyleProperty(element: HTMLElement, name: string, value: string): void {
  if (element.style && typeof element.style.setProperty === 'function') {
    element.style.setProperty(name, value);
    return;
  }
  (element.style as any)[name] = value;
}

function identifierFromEntry(entry: any): string {
  return cleanText(entry && (entry.issue_identifier || entry.identifier || entry.issue_id));
}

function chooseFocus(model: any): any | null {
  const running = Array.isArray(model?.running) ? model.running : [];
  const blocked = Array.isArray(model?.blocked) ? model.blocked : [];
  const retry = Array.isArray(model?.retry) ? model.retry : [];
  const active = ([] as any[]).concat(running, blocked, retry);
  return (
    active.find((entry) => identifierFromEntry(entry) === 'NIE-300') ||
    model?.focus ||
    running[0] ||
    blocked[0] ||
    retry[0] ||
    null
  );
}

function titleFromEntry(entry: any, identifier: string): string {
  const candidates = [
    entry?.issue_title,
    entry?.title,
    entry?.headline,
    entry?.operator_explainer_hint?.headline,
    entry?.conversation_latest?.summary,
    entry?.last_event_summary,
    entry?.last_message
  ];
  for (const candidate of candidates) {
    const text = truncate(cleanText(candidate), 42);
    if (text && text !== identifier) {
      return identifier === 'NIE-300' && text.length > 28 ? 'Chatty' : text;
    }
  }
  return identifier === 'NIE-300' ? 'Chatty' : 'Focused Run';
}

function roleFromEvent(event: any): AgentRole {
  const normalized = cleanText(`${event?.event || ''} ${event?.request_category || ''} ${event?.request_method || ''}`).toLowerCase();
  if (event?.tool_name || event?.tool_call_id || normalized.includes('tool')) {
    return 'tool';
  }
  if (normalized.includes('assistant') || normalized.includes('turn')) {
    return 'assistant';
  }
  if (normalized.includes('input') || normalized.includes('user')) {
    return 'user';
  }
  if (normalized.includes('system') || normalized.includes('protocol')) {
    return 'system';
  }
  return 'runtime';
}

function roleCountsFromEntry(entry: any): Record<AgentRole, number> {
  const metadataCounts = entry?.conversation?.metadata?.role_counts;
  const counts: Record<AgentRole, number> = {
    system: Number(metadataCounts?.system || 0),
    user: Number(metadataCounts?.user || 0),
    assistant: Number(metadataCounts?.assistant || 0),
    tool: Number(metadataCounts?.tool || 0),
    runtime: Number(metadataCounts?.runtime || 0)
  };

  const messages = Array.isArray(entry?.conversation?.messages) ? entry.conversation.messages : [];
  for (const message of messages) {
    const role = cleanText(message?.role) as AgentRole;
    if (role in counts && !metadataCounts) {
      counts[role] += 1;
    }
  }

  const recentEvents = ([] as any[]).concat(
    Array.isArray(entry?.recent_events) ? entry.recent_events : [],
    Array.isArray(entry?.session_console) ? entry.session_console : []
  );
  for (const event of recentEvents) {
    counts[roleFromEvent(event)] += 1;
  }

  const latestRole = cleanText(entry?.conversation_latest?.role) as AgentRole;
  if (latestRole in counts && counts[latestRole] === 0) {
    counts[latestRole] += 1;
  }

  return counts;
}

function roleStreamFromEntry(entry: any | null): RoleStream[] {
  if (!entry) {
    return FALLBACK_LENS.roleStream;
  }
  const counts = roleCountsFromEntry(entry);
  const stream = (['assistant', 'tool', 'user', 'system', 'runtime'] as AgentRole[])
    .map((role) => ({ role, count: counts[role] || 0 }))
    .filter((item) => item.count > 0)
    .slice(0, 4);
  return stream.length ? stream : FALLBACK_LENS.roleStream;
}

function eventLabel(event: any, index: number): string {
  const tool = cleanText(event?.tool_name);
  const normalizedTool = tool.toLowerCase();
  if (tool) {
    if (normalizedTool.includes('linear')) {
      return 'Linear';
    }
    if (normalizedTool.includes('exec') || normalizedTool.includes('shell') || normalizedTool.includes('terminal')) {
      return 'terminal';
    }
    return truncate(tool, 14);
  }

  const eventName = cleanText(event?.event);
  if (/git|commit|branch/i.test(eventName)) {
    return 'git';
  }
  if (/linear|issue|tracker/i.test(eventName)) {
    return 'Linear';
  }
  if (/build|bundle|asset/i.test(eventName)) {
    return 'build';
  }
  if (/test|vitest|check/i.test(eventName)) {
    return 'tests';
  }
  if (/tool|command|exec|terminal/i.test(eventName)) {
    return 'terminal';
  }
  return ['terminal', 'git', 'Linear', 'build', 'tests'][index % 5];
}

function eventTone(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized === 'git') {
    return 'orange';
  }
  if (normalized === 'linear') {
    return 'violet';
  }
  if (normalized === 'build') {
    return 'green';
  }
  if (normalized === 'tests') {
    return 'cyan';
  }
  return 'blue';
}

function formatEventTime(event: any): string {
  const raw = event?.at || event?.observed_at || event?.at_ms;
  const parsed = typeof raw === 'number' ? raw : Date.parse(cleanText(raw));
  if (!Number.isFinite(parsed)) {
    return '--:--:--';
  }
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function eventsFromEntry(entry: any | null): LensEvent[] {
  if (!entry) {
    return FALLBACK_LENS.events;
  }
  const source = ([] as any[]).concat(
    Array.isArray(entry?.recent_events) ? entry.recent_events : [],
    Array.isArray(entry?.conversation?.messages) ? entry.conversation.messages : [],
    Array.isArray(entry?.session_console) ? entry.session_console : []
  );
  const events = source
    .slice(-8)
    .reverse()
    .map((event, index) => {
      const label = eventLabel(event, index);
      return {
        label,
        detail: truncate(cleanText(event?.message || event?.content || event?.event || event?.source || 'activity'), 30),
        at: formatEventTime(event),
        tone: eventTone(label)
      };
    })
    .filter((event) => event.detail || event.label)
    .slice(0, 5);
  return events.length ? events : FALLBACK_LENS.events;
}

function latestMessageFromEntry(entry: any | null): { role: string; message: string; at: string } {
  if (!entry) {
    return {
      role: FALLBACK_LENS.latestRole,
      message: FALLBACK_LENS.latestMessage,
      at: FALLBACK_LENS.latestAt
    };
  }
  const latest = entry.conversation_latest || entry.conversation?.latest || {};
  const role = cleanText(latest.role) || (entry.pending_input_preview ? 'user' : 'assistant');
  const message =
    cleanText(latest.summary) ||
    cleanText(entry.last_message) ||
    cleanText(entry.pending_input_preview?.prompt_preview) ||
    cleanText(entry.last_event_summary) ||
    'No agent message has been observed yet.';
  const at = cleanText(latest.at) || cleanText(entry.last_event_at) || cleanText(entry.started_at);
  return {
    role,
    message: truncate(message, 170),
    at: at ? formatEventTime({ at }) + ' - now' : '--:--:--'
  };
}

function contextFromEntry(entry: any | null): { visible: number; clipped: number; percent: number } {
  const total = Number(entry?.tokens?.total_tokens || 0);
  const windowSize = Number(entry?.tokens?.model_context_window || 0);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(windowSize) && windowSize > 0) {
    const visible = Math.max(1, Math.round(total / 1000));
    const capacity = Math.max(visible, Math.round(windowSize / 1000));
    const clipped = Math.max(0, capacity - visible);
    return {
      visible,
      clipped,
      percent: Math.max(8, Math.min(100, Math.round((visible / capacity) * 100)))
    };
  }
  return {
    visible: FALLBACK_LENS.contextVisible,
    clipped: FALLBACK_LENS.contextClipped,
    percent: FALLBACK_LENS.contextPercent
  };
}

function confidenceFromEntry(entry: any | null): { confidence: number; label: string } {
  const summary = entry?.transcript_tool_call_diagnostic_summary;
  if (!entry) {
    return { confidence: FALLBACK_LENS.confidence, label: FALLBACK_LENS.confidenceLabel };
  }
  if (summary?.active_missing_tool_output?.active) {
    return { confidence: 0.61, label: 'missing output' };
  }
  if (summary?.detailed_diagnostics_available || summary?.total_count > 0 || entry?.conversation_latest?.summary) {
    return { confidence: 0.92, label: 'high' };
  }
  if (entry?.last_message || entry?.last_event_summary) {
    return { confidence: 0.78, label: 'partial' };
  }
  return { confidence: 0.54, label: 'thin' };
}

function buildLensModel(model: any): LensModel {
  const focus = chooseFocus(model || {});
  if (!focus) {
    return FALLBACK_LENS;
  }
  const identifier = identifierFromEntry(focus) || FALLBACK_LENS.identifier;
  const latest = latestMessageFromEntry(focus);
  const context = contextFromEntry(focus);
  const confidence = confidenceFromEntry(focus);
  return {
    identifier,
    title: titleFromEntry(focus, identifier),
    runLabel: 'Run Attempt #' + String(focus.retry_attempt ?? focus.attempt ?? focus.attempt_number ?? 1),
    latestRole: latest.role,
    latestMessage: latest.message,
    latestAt: latest.at,
    threadId: cleanText(focus.thread_id || focus.previous_thread_id || focus.persisted_thread_id) || FALLBACK_LENS.threadId,
    sessionId: cleanText(focus.session_id || focus.previous_session_id) || FALLBACK_LENS.sessionId,
    confidence: confidence.confidence,
    confidenceLabel: confidence.label,
    roleStream: roleStreamFromEntry(focus),
    events: eventsFromEntry(focus),
    contextVisible: context.visible,
    contextClipped: context.clipped,
    contextPercent: context.percent
  };
}

function renderFocusPill(lens: LensModel): HTMLElement {
  const pill = createElement('section', 'lens-focus-pill');
  const identifier = createElement('div', 'lens-focus-id', lens.identifier);
  const title = createElement('div', 'lens-focus-title', lens.title);
  const run = createElement('div', 'lens-focus-run', lens.runLabel);
  pill.append(identifier, title, run);
  return pill;
}

function renderCurrentMessage(lens: LensModel): HTMLElement {
  const card = createElement('section', 'lens-current-message');
  card.append(
    createElement('div', 'lens-label', 'Latest Message'),
    createElement('div', 'lens-message-role', 'role: ' + lens.latestRole),
    createElement('p', 'lens-message-body', lens.latestMessage),
    createElement('div', 'lens-message-time', lens.latestAt)
  );
  return card;
}

function renderRoleStream(lens: LensModel): HTMLElement {
  const panel = createElement('section', 'lens-role-stream');
  panel.append(createElement('div', 'lens-label', 'Recent Roles'));
  const lanes = createElement('div', 'lens-stream-lanes');
  lens.roleStream.forEach((entry, index) => {
    const lane = createElement('div', 'lens-stream-lane lens-stream-' + entry.role);
    setStyleProperty(lane, '--stream-index', String(index));
    setStyleProperty(lane, '--stream-count', String(Math.max(1, Math.min(8, entry.count))));
    lane.append(createElement('span', 'lens-stream-role', entry.role), createElement('strong', 'lens-stream-count', String(entry.count)));
    lanes.appendChild(lane);
  });
  panel.appendChild(lanes);
  return panel;
}

function renderEventOrbit(lens: LensModel): HTMLElement {
  const orbit = createElement('div', 'lens-event-orbit');
  lens.events.forEach((event, index) => {
    const isRearOrbit = index >= 2;
    const node = createElement(
      'article',
      'lens-event-node lens-event-' + event.tone + (isRearOrbit ? ' lens-event-node-compact' : '')
    );
    const path = createElement('span', 'lens-event-path');
    const body = createElement('span', 'lens-event-body');
    const angle = lens.events.length > 1 ? -130 + index * (260 / (lens.events.length - 1)) : -28;
    const radius = isRearOrbit ? 178 + (index % 2) * 34 : 182 + index * 48;
    const speed = 22 + index * 4;
    const phase = ((Date.now() / 1000) + index * 3) % speed;
    const scale = isRearOrbit ? 0.74 : index % 3 === 0 ? 0.88 : 1.02;
    setStyleProperty(node, '--orbit-angle', String(angle) + 'deg');
    setStyleProperty(node, '--orbit-counter-angle', String(-angle) + 'deg');
    setStyleProperty(node, '--orbit-radius', String(radius) + 'px');
    setStyleProperty(node, '--orbit-speed', String(speed) + 's');
    setStyleProperty(node, '--orbit-delay', '-' + phase.toFixed(2) + 's');
    setStyleProperty(node, '--orbit-scale', String(scale));
    const bead = createElement('span', 'lens-event-bead', event.label.slice(0, 1).toUpperCase());
    const copy = createElement('span', 'lens-event-copy');
    copy.append(createElement('strong', 'lens-event-label', event.label), createElement('span', 'lens-event-time', event.at));
    if (isRearOrbit) {
      body.title = event.label + ' - ' + event.at;
    }
    body.append(bead, copy);
    path.appendChild(body);
    node.appendChild(path);
    orbit.appendChild(node);
  });
  return orbit;
}

function renderConfidence(lens: LensModel): HTMLElement {
  const panel = createElement('aside', 'lens-confidence');
  panel.append(
    createElement('span', 'lens-label', 'Transcript Coverage'),
    createElement('strong', 'lens-confidence-score', lens.confidence.toFixed(2)),
    createElement('span', 'lens-confidence-label', lens.confidenceLabel)
  );
  return panel;
}

function renderContextMeter(lens: LensModel): HTMLElement {
  const panel = createElement('section', 'lens-context-meter');
  const ticks = createElement('div', 'lens-context-ticks');
  setStyleProperty(ticks, '--context-fill', String(lens.contextPercent) + '%');
  const filledTicks = Math.max(1, Math.min(20, Math.round(lens.contextPercent / 5)));
  for (let index = 0; index < 20; index += 1) {
    ticks.appendChild(createElement('span', index < filledTicks ? 'lens-context-tick lens-context-tick-filled' : 'lens-context-tick'));
  }
  panel.append(
    createElement('div', 'lens-label', 'Visible Context'),
    createElement('strong', 'lens-context-visible', String(lens.contextVisible) + ' messages'),
    ticks,
    createElement('div', 'lens-context-clip', String(lens.contextVisible) + ' visible / ' + String(lens.contextClipped) + ' clipped')
  );
  return panel;
}

function renderEvidenceDock(lens: LensModel): HTMLElement {
  const dock = createElement('section', 'lens-evidence-dock');
  const thread = createElement('span', 'lens-evidence-node', 'thread ' + lens.threadId);
  const session = createElement('span', 'lens-evidence-node', 'session ' + lens.sessionId);
  const transcript = createElement('span', 'lens-evidence-node', 'transcript');
  const snapshot = createElement('span', 'lens-evidence-node', 'state snapshot');
  const audit = createElement('span', 'lens-evidence-node', 'audit receipt');
  for (const node of [thread, session, transcript, snapshot, audit]) {
    node.title = node.textContent || '';
  }
  dock.append(thread, session, transcript, snapshot, audit);
  return dock;
}

function renderCoreStar(): HTMLElement {
  const core = createElement('div', 'lens-core-star');
  core.append(
    createElement('span', 'lens-star-pulse'),
    createElement('span', 'lens-star-point'),
    createElement('span', 'lens-star-grid')
  );
  return core;
}

function renderDepthField(): HTMLElement {
  const field = createElement('div', 'lens-depth-field');
  field.append(
    createElement('span', 'lens-depth-plane lens-depth-plane-back'),
    createElement('span', 'lens-depth-plane lens-depth-plane-mid'),
    createElement('span', 'lens-depth-plane lens-depth-plane-front')
  );
  return field;
}

function renderOrbitTracks(): HTMLElement {
  const tracks = createElement('div', 'lens-orbit-tracks');
  tracks.append(
    createElement('span', 'lens-orbit-track lens-orbit-track-alpha'),
    createElement('span', 'lens-orbit-track lens-orbit-track-beta'),
    createElement('span', 'lens-orbit-track lens-orbit-track-gamma'),
    createElement('span', 'lens-orbit-track lens-orbit-track-delta')
  );
  return tracks;
}

export function renderConstellationCore(model: any) {
  if (!elements.constellationCore) {
    return;
  }

  const lens = buildLensModel(model || {});
  const root = createElement('div', 'lens-system');
  root.append(
    renderDepthField(),
    renderOrbitTracks(),
    createElement('span', 'lens-ring lens-ring-outer'),
    createElement('span', 'lens-ring lens-ring-middle'),
    createElement('span', 'lens-ring lens-ring-inner'),
    renderFocusPill(lens),
    renderCurrentMessage(lens),
    renderRoleStream(lens),
    renderEventOrbit(lens),
    renderCoreStar(),
    renderConfidence(lens),
    renderContextMeter(lens),
    renderEvidenceDock(lens)
  );
  elements.constellationCore.replaceChildren(root);
}
