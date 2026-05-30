import { elements } from './dom';

type GravityTone = 'focus' | 'running' | 'warning' | 'blocked';
type GravitySource = 'running' | 'blocked' | 'retry';

interface GravityItem {
  identifier: string;
  title: string;
  detail: string;
  gravity: number;
  tone: GravityTone;
  source: GravitySource;
}

const FALLBACK_ITEMS: GravityItem[] = [
  {
    identifier: 'NIE-312',
    title: 'Auth Flow Polish',
    detail: 'needs review',
    gravity: 0.72,
    tone: 'warning',
    source: 'retry'
  },
  {
    identifier: 'NIE-287',
    title: 'Telemetry Ingestion',
    detail: 'warning',
    gravity: 0.37,
    tone: 'warning',
    source: 'retry'
  },
  {
    identifier: 'NIE-301',
    title: 'Snapshot Diffing',
    detail: 'running',
    gravity: 0.24,
    tone: 'running',
    source: 'running'
  },
  {
    identifier: 'NIE-300',
    title: 'Chatty',
    detail: 'focus',
    gravity: 0.91,
    tone: 'focus',
    source: 'running'
  },
  {
    identifier: 'NIE-298',
    title: 'Linear Webhooks',
    detail: 'running',
    gravity: 0.18,
    tone: 'running',
    source: 'running'
  },
  {
    identifier: 'NIE-276',
    title: 'UI Refactor',
    detail: 'blocked',
    gravity: 0.63,
    tone: 'blocked',
    source: 'blocked'
  }
];

function cleanText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function titleFromEntry(entry: any, identifier: string): string {
  const candidates = [
    entry.issue_title,
    entry.title,
    entry.headline,
    entry.operator_explainer_hint && entry.operator_explainer_hint.headline,
    entry.last_event_summary,
    entry.last_message,
    entry.conversation_latest && entry.conversation_latest.summary
  ];

  for (const candidate of candidates) {
    const text = cleanText(candidate);
    if (text && text !== identifier) {
      return text.length > 34 ? text.slice(0, 31) + '...' : text;
    }
  }

  if (identifier === 'NIE-300') {
    return 'Chatty';
  }
  return 'Runtime Work';
}

function detailFromEntry(entry: any, source: GravitySource, tone: GravityTone): string {
  if (tone === 'focus') {
    return 'focus';
  }
  if (source === 'blocked') {
    if (entry.awaiting_operator_reason_code) {
      return 'blocked: ' + cleanText(entry.awaiting_operator_reason_code).replace(/_/g, ' ');
    }
    if (entry.stop_reason_code) {
      return 'blocked: ' + cleanText(entry.stop_reason_code).replace(/_/g, ' ');
    }
    return 'blocked';
  }
  if (source === 'retry') {
    if (entry.due_state === 'overdue') {
      return 'retry overdue';
    }
    if (entry.stop_reason_code) {
      return 'retry: ' + cleanText(entry.stop_reason_code).replace(/_/g, ' ');
    }
    return 'retry scheduled';
  }
  if (entry.awaiting_input) {
    return 'awaiting input';
  }
  if (entry.stalled_waiting) {
    return 'waiting';
  }
  if (entry.current_phase) {
    return cleanText(entry.current_phase).replace(/_/g, ' ');
  }
  if (entry.progress_signal_state) {
    return cleanText(entry.progress_signal_state).replace(/_/g, ' ');
  }
  return 'running';
}

function sourceTone(entry: any, source: GravitySource, identifier: string, focusIdentifier: string): GravityTone {
  if (identifier === focusIdentifier) {
    return 'focus';
  }
  if (source === 'blocked') {
    return 'blocked';
  }
  if (source === 'retry' || entry.due_state === 'overdue') {
    return 'warning';
  }
  return 'running';
}

function gravityFromEntry(entry: any, source: GravitySource, tone: GravityTone, index: number): number {
  if (typeof entry.gravity === 'number' && Number.isFinite(entry.gravity)) {
    return Math.max(0.01, Math.min(0.99, entry.gravity));
  }
  if (tone === 'focus') {
    return 0.91;
  }
  if (source === 'blocked') {
    return entry.awaiting_operator ? 0.72 : 0.63;
  }
  if (source === 'retry') {
    return entry.due_state === 'overdue' ? 0.72 : 0.37;
  }
  if (entry.awaiting_input) {
    return 0.63;
  }
  if (entry.stalled_waiting) {
    return 0.37;
  }
  return Math.max(0.18, 0.31 - index * 0.04);
}

function normalizeEntry(entry: any, source: GravitySource, focusIdentifier: string, index: number): GravityItem | null {
  const identifier = cleanText(entry.issue_identifier || entry.identifier || entry.issue_id);
  if (!identifier) {
    return null;
  }
  const tone = sourceTone(entry, source, identifier, focusIdentifier);
  return {
    identifier,
    title: titleFromEntry(entry, identifier),
    detail: detailFromEntry(entry, source, tone),
    gravity: gravityFromEntry(entry, source, tone, index),
    tone,
    source
  };
}

function chooseFocusIdentifier(entries: any[], focus: any): string {
  const chatty = entries.find((entry) => cleanText(entry.issue_identifier || entry.identifier || entry.issue_id) === 'NIE-300');
  if (chatty) {
    return 'NIE-300';
  }
  return cleanText(focus && (focus.issue_identifier || focus.identifier || focus.issue_id));
}

function collectItems(model: any): GravityItem[] {
  const running = Array.isArray(model.running) ? model.running : [];
  const blocked = Array.isArray(model.blocked) ? model.blocked : [];
  const retry = Array.isArray(model.retry) ? model.retry : [];
  const entries = ([] as Array<{ entry: any; source: GravitySource }>).concat(
    retry.map((entry: any) => ({ entry, source: 'retry' })),
    running.map((entry: any) => ({ entry, source: 'running' })),
    blocked.map((entry: any) => ({ entry, source: 'blocked' }))
  );

  if (!entries.length) {
    return FALLBACK_ITEMS;
  }

  const focusIdentifier = chooseFocusIdentifier(
    entries.map((item) => item.entry),
    model.focus
  );
  const seen = new Set<string>();
  return entries
    .map((item, index) => normalizeEntry(item.entry, item.source, focusIdentifier, index))
    .filter((item): item is GravityItem => Boolean(item))
    .filter((item) => {
      if (seen.has(item.identifier)) {
        return false;
      }
      seen.add(item.identifier);
      return true;
    })
    .sort((left, right) => right.gravity - left.gravity)
    .slice(0, 6);
}

function glyphForTone(tone: GravityTone): string {
  if (tone === 'focus') {
    return '*';
  }
  if (tone === 'blocked') {
    return '!';
  }
  if (tone === 'warning') {
    return '#';
  }
  return '~';
}

function createTextElement(className: string, text: string): HTMLElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function setStyleProperty(element: HTMLElement, name: string, value: string): void {
  if (element.style && typeof element.style.setProperty === 'function') {
    element.style.setProperty(name, value);
    return;
  }
  (element.style as any)[name] = value;
}

function openConstellationIssue(identifier: string): void {
  if (!identifier || typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }
  window.dispatchEvent(new CustomEvent('symphony:constellation-issue', { detail: { identifier } }));
}

function renderRow(item: GravityItem, index: number): HTMLElement {
  const row = document.createElement('article');
  row.className = 'gravity-row gravity-row-' + item.tone;
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('data-issue-identifier', item.identifier);
  row.setAttribute('aria-label', item.identifier + ' ' + item.title + ' priority ' + item.gravity.toFixed(2));
  row.title = 'Open ' + item.identifier + ' issue detail';
  row.addEventListener('click', function () {
    openConstellationIssue(item.identifier);
  });
  row.addEventListener('keydown', function (event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    openConstellationIssue(item.identifier);
  });

  const glyph = createTextElement('gravity-glyph', glyphForTone(item.tone));
  const copy = document.createElement('span');
  copy.className = 'gravity-copy';
  copy.append(
    createTextElement('gravity-identifier', item.identifier),
    createTextElement('gravity-title', item.title),
    createTextElement('gravity-detail', item.detail)
  );

  const value = document.createElement('span');
  value.className = 'gravity-value';
  value.append(createTextElement('gravity-score', item.gravity.toFixed(2)), createTextElement('gravity-unit', 'priority'));

  const strand = document.createElement('span');
  strand.className = 'gravity-strand';
  const orbitalRoutes = [
    { width: 326, lift: 12, bend: 108, tilt: 13, sweep: -1 },
    { width: 268, lift: 8, bend: 86, tilt: 8, sweep: -1 },
    { width: 222, lift: 2, bend: 68, tilt: 3, sweep: -1 },
    { width: 216, lift: -2, bend: 68, tilt: -3, sweep: 1 },
    { width: 248, lift: -8, bend: 82, tilt: -8, sweep: 1 },
    { width: 292, lift: -12, bend: 102, tilt: -13, sweep: 1 }
  ];
  const route = orbitalRoutes[index] || orbitalRoutes[orbitalRoutes.length - 1];
  setStyleProperty(strand, '--strand-width', String(route.width) + 'px');
  setStyleProperty(strand, '--strand-lift', String(route.lift) + 'px');
  setStyleProperty(strand, '--strand-bend', String(route.bend) + 'px');
  setStyleProperty(strand, '--strand-tilt', String(route.tilt) + 'deg');
  setStyleProperty(strand, '--strand-sweep', String(route.sweep));
  strand.appendChild(createTextElement('gravity-dot', ''));

  row.append(glyph, copy, value, strand);
  return row;
}

export function renderConstellationGravity(model: any) {
  if (!elements.constellationIssueList) {
    return;
  }

  const items = collectItems(model || {});
  const rows = items.map(renderRow);
  elements.constellationIssueList.replaceChildren(...rows);
}
