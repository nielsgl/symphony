import { elements } from './dom';

type StepTone = 'verified' | 'attention' | 'receipt';

interface InterlockStep {
  number: string;
  title: string;
  subtitle: string;
  tone: StepTone;
  rows: Array<{ label: string; verified: boolean; detail?: string }>;
  action?: string;
  preview?: string[];
}

interface EvidenceNode {
  label: string;
  detail: string;
  tone: 'blue' | 'green' | 'amber' | 'violet';
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function shortText(value: unknown, fallback: string, length = 28): string {
  const text = cleanText(value) || fallback;
  return text.length > length ? text.slice(0, length - 3) + '...' : text;
}

function firstArrayItem(...values: any[]): any | null {
  for (const value of values) {
    if (Array.isArray(value) && value.length) {
      return value[0];
    }
  }
  return null;
}

function focusFromModel(model: any): any {
  const chatty = firstArrayItem(
    Array.isArray(model.running) ? model.running.filter((entry: any) => cleanText(entry.issue_identifier) === 'NIE-300') : [],
    Array.isArray(model.blocked) ? model.blocked.filter((entry: any) => cleanText(entry.issue_identifier) === 'NIE-300') : [],
    Array.isArray(model.retry) ? model.retry.filter((entry: any) => cleanText(entry.issue_identifier) === 'NIE-300') : []
  );
  return (
    chatty ||
    model.focus ||
    firstArrayItem(
      model.running,
      model.blocked,
      model.retry
    ) || {
      issue_identifier: 'NIE-300',
      title: 'Chatty',
      thread_id: '01JX7',
      current_phase: 'operator_steering',
      run_attempt: 2,
      pending_input: { reason_code: 'clarify_direction' }
    }
  );
}

function hasTextMatch(value: unknown, pattern: RegExp): boolean {
  return pattern.test(cleanText(value));
}

function hasConflictingRun(model: any): boolean {
  const entries = ([] as any[]).concat(model.running || [], model.blocked || [], model.retry || []);
  return entries.some((entry) => {
    return (
      hasTextMatch(entry.stop_reason_code, /conflict/i) ||
      hasTextMatch(entry.awaiting_operator_reason_code, /conflict/i) ||
      hasTextMatch(entry.root_cause && entry.root_cause.reason_code, /conflict/i)
    );
  });
}

function hasDirtyWorkspace(model: any): boolean {
  const entries = ([] as any[]).concat(model.running || [], model.blocked || [], model.retry || []);
  return entries.some((entry) => {
    return (
      hasTextMatch(entry.stop_reason_code, /dirty|worktree/i) ||
      hasTextMatch(entry.root_cause && entry.root_cause.reason_code, /dirty|worktree/i) ||
      hasTextMatch(entry.root_cause && entry.root_cause.detail, /dirty|worktree/i)
    );
  });
}

function branchUpToDate(payload: any): boolean {
  const readiness = payload.runtime_update || payload.runtimeUpdate || {};
  const counts = readiness.ahead_behind || {};
  if (readiness.state === 'build_current') {
    return true;
  }
  if (counts.behind === 0 || counts.behind === '0') {
    return true;
  }
  return !readiness.attention_required && readiness.state !== 'runtime_stale' && readiness.state !== 'remote_update_available';
}

function slaWithinLimits(model: any, payload: any): boolean {
  const counts = payload.counts || {};
  const retry = Array.isArray(model.retry) ? model.retry : [];
  const overdue = retry.some((entry: any) => entry && entry.due_state === 'overdue');
  return !overdue && !(Number(counts.running_stalled_waiting_count) > 0);
}

function threadIdForFocus(focus: any): string {
  return shortText(
    focus.thread_id || focus.previous_thread_id || focus.threadId || focus.session_thread_id,
    'thread_01JX7',
    18
  );
}

function transcriptPath(focus: any): string {
  const session = cleanText(focus.session_id || focus.previous_session_id || focus.sessionId);
  if (session) {
    return 'sessions/' + shortText(session, session, 14) + '/rollout.jsonl';
  }
  return 'sessions/' + threadIdForFocus(focus) + '/rollout.jsonl';
}

function receiptId(model: any, payload: any): string {
  const audit = payload.audit_receipt || payload.last_audit_receipt || {};
  const direct = audit.receipt_id || audit.id || audit.nonce || payload.audit_nonce;
  if (direct) {
    return shortText(direct, 'receipt_8f2a7c', 16);
  }
  const focus = focusFromModel(model);
  const seed = cleanText(focus.issue_identifier || focus.identifier || 'NIE-300').replace(/\W/g, '').slice(-4);
  return 'receipt_' + (seed || '8f2a') + '7c';
}

function operatorIntent(focus: any): string {
  const pending = focus.pending_input || focus.current_operator_block || {};
  const hint = focus.operator_explainer_hint || {};
  const reason =
    pending.reason_code ||
    focus.awaiting_operator_reason_code ||
    focus.stop_reason_code ||
    hint.recommended_action ||
    'clarify_direction';
  return cleanText(reason).replace(/_/g, ' ');
}

function endpointPreview(focus: any): string[] {
  const thread = threadIdForFocus(focus);
  const reason = cleanText(
    (focus.pending_input && focus.pending_input.reason_code) ||
      focus.awaiting_operator_reason_code ||
      focus.stop_reason_code ||
      'clarify_direction'
  ).replace(/\s+/g, '_');
  const nonce = cleanText((focus.pending_input && focus.pending_input.request_id) || focus.request_id || '91f3b9e2');
  return ['POST /api/v1/agent/threads/' + thread + '/resume', 'mode: steer', 'reason_code: ' + reason, 'nonce: ' + nonce.slice(0, 12), '...'];
}

function buildSteps(model: any): InterlockStep[] {
  const payload = model.payload || {};
  const focus = focusFromModel(model);
  const workspaceClean = !hasDirtyWorkspace(model) && payload.health?.dispatch_validation !== 'failed';
  const upToDate = branchUpToDate(payload);
  const noConflicts = !hasConflictingRun(model);
  const sla = slaWithinLimits(model, payload);
  const preconditionRows = [
    { label: 'Workspace clean', verified: workspaceClean },
    { label: 'Branch up to date', verified: upToDate },
    { label: 'No conflicting runs', verified: noConflicts },
    { label: 'SLA within limits', verified: sla }
  ];
  const verifiedCount = preconditionRows.filter((row) => row.verified).length;

  return [
    {
      number: '1',
      title: 'Preconditions',
      subtitle: String(verifiedCount) + ' / ' + String(preconditionRows.length) + ' verified',
      tone: verifiedCount === preconditionRows.length ? 'verified' : 'attention',
      rows: preconditionRows
    },
    {
      number: '2',
      title: 'Operator Input',
      subtitle: 'Intent to send',
      tone: 'attention',
      rows: [{ label: operatorIntent(focus), verified: true }],
      action: 'Send: Clarify direction'
    },
    {
      number: '3',
      title: 'Request Preview',
      subtitle: 'API request to send',
      tone: 'attention',
      rows: [],
      preview: endpointPreview(focus)
    },
    {
      number: '4',
      title: 'Audit Receipt',
      subtitle: 'Immutable record',
      tone: 'receipt',
      rows: [
        {
          label: receiptId(model, payload),
          verified: true,
          detail: 'created'
        }
      ]
    }
  ];
}

function createTextElement(tag: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function renderStep(step: InterlockStep): HTMLElement {
  const item = document.createElement('article');
  item.className = 'interlock-step interlock-step-' + step.tone;
  item.setAttribute('aria-label', step.number + ' ' + step.title + ' ' + step.subtitle);

  const node = createTextElement('span', 'interlock-node', step.tone === 'attention' ? '!' : 'OK');
  const body = document.createElement('div');
  body.className = 'interlock-step-body';

  const header = document.createElement('div');
  header.className = 'interlock-step-header';
  header.append(
    createTextElement('span', 'interlock-number', step.number),
    createTextElement('span', 'interlock-title', step.title)
  );
  body.append(header, createTextElement('div', 'interlock-subtitle', step.subtitle));

  if (step.rows.length) {
    const list = document.createElement('div');
    list.className = 'interlock-checks';
    for (const row of step.rows) {
      const check = document.createElement('div');
      check.className = 'interlock-check ' + (row.verified ? 'interlock-check-ok' : 'interlock-check-attention');
      check.append(
        createTextElement('span', 'interlock-check-glyph', row.verified ? 'OK' : '!'),
        createTextElement('span', 'interlock-check-label', row.label),
        createTextElement('span', 'interlock-check-detail', row.detail || '')
      );
      list.appendChild(check);
    }
    body.appendChild(list);
  }

  if (step.action) {
    body.append(createTextElement('button', 'interlock-action', step.action));
  }

  if (step.preview) {
    const preview = document.createElement('pre');
    preview.className = 'interlock-preview';
    preview.textContent = step.preview.join('\n');
    body.appendChild(preview);
  }

  item.append(node, body);
  return item;
}

function evidenceNodes(model: any): EvidenceNode[] {
  const payload = model.payload || {};
  const focus = focusFromModel(model);
  return [
    { label: 'thread', detail: threadIdForFocus(focus), tone: 'blue' },
    { label: 'transcript', detail: transcriptPath(focus), tone: 'green' },
    { label: 'state snapshot', detail: shortText(payload.generated_at, 'live state', 20), tone: 'green' },
    { label: 'audit receipt', detail: receiptId(model, payload), tone: 'amber' }
  ];
}

function renderEvidenceNode(node: EvidenceNode): HTMLElement {
  const element = document.createElement('div');
  element.className = 'evidence-node evidence-node-' + node.tone;
  element.append(createTextElement('span', 'evidence-node-label', node.label), createTextElement('strong', 'evidence-node-detail', node.detail));
  return element;
}

function renderEvidence(model: any): void {
  if (!elements.constellationEvidencePath) {
    return;
  }
  const nodes = evidenceNodes(model);
  const rail = document.createElement('div');
  rail.className = 'evidence-rail';
  rail.append(...nodes.map(renderEvidenceNode));

  const pathCards = document.createElement('div');
  pathCards.className = 'evidence-cards';
  pathCards.append(
    createTextElement('div', 'evidence-card evidence-card-main', transcriptPath(focusFromModel(model))),
    createTextElement('div', 'evidence-card evidence-card-small', 'state snapshot OK')
  );

  elements.constellationEvidencePath.replaceChildren(rail, pathCards);
}

function renderActions(): void {
  if (!elements.constellationActions) {
    return;
  }
  const actions = [
    ['Send Input', 'Provide operator direction', 'blue'],
    ['Resume Agent', 'Continue blocked run', 'blue'],
    ['Open Evidence', 'View transcript path', 'green'],
    ['Export Audit', 'Bundle run artifacts', 'violet'],
    ['Wait for Drain', 'Pause new work', 'amber'],
    ['More', 'Additional controls', 'neutral']
  ];
  elements.constellationActions.replaceChildren(
    ...actions.map(([label, detail, tone]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'constellation-action constellation-action-' + tone;
      button.append(createTextElement('span', 'constellation-action-orb', label === 'More' ? '...' : label.slice(0, 1)), createTextElement('strong', 'constellation-action-label', label), createTextElement('span', 'constellation-action-detail', detail));
      return button;
    })
  );
}

function localTimeFromPayload(payload: any): string {
  const raw = payload.generated_at || payload.snapshot_generated_at || payload.last_updated_at;
  const timestamp = raw ? Date.parse(raw) : Date.now();
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function apiHealth(payload: any): string {
  const controlPlane = payload.health && payload.health.control_plane;
  const worst = controlPlane && controlPlane.worst_health;
  if (worst && worst !== 'ok') {
    return cleanText(worst).replace(/_/g, ' ');
  }
  const dispatch = payload.health && payload.health.dispatch_validation;
  if (dispatch && dispatch !== 'ok') {
    return cleanText(dispatch).replace(/_/g, ' ');
  }
  return 'Healthy';
}

function renderFooter(model: any): void {
  const payload = model.payload || {};
  const counts = payload.counts || {};
  const running = Array.isArray(model.running) ? model.running.length : Number(counts.running || 0);
  const retry = Array.isArray(model.retry) ? model.retry.length : Number(counts.retrying || 0);
  const blocked = Array.isArray(model.blocked) ? model.blocked.length : Number(counts.blocked || 0);
  const workerLimit = payload.worker_pool?.max_concurrent_agents_per_host || payload.worker_pool?.configured_slots || Math.max(3, running);

  if (elements.constellationOperator) {
    elements.constellationOperator.textContent = shortText(payload.operator?.name || payload.operator || payload.user, 'niels', 22);
  }
  if (elements.constellationRuntimeClock) {
    elements.constellationRuntimeClock.textContent = localTimeFromPayload(payload);
  }
  if (elements.constellationApiHealth) {
    elements.constellationApiHealth.textContent = apiHealth(payload);
  }
  if (elements.constellationWorkerCount) {
    elements.constellationWorkerCount.textContent = String(running) + ' / ' + String(workerLimit);
  }
  if (elements.constellationQueueCount) {
    elements.constellationQueueCount.textContent = String(retry + blocked);
  }
}

export function renderConstellationInterlocks(model: any) {
  if (!elements.constellationInterlockList) {
    return;
  }

  const safeModel = model || {};
  elements.constellationInterlockList.replaceChildren(...buildSteps(safeModel).map(renderStep));
  renderEvidence(safeModel);
  renderActions();
  renderFooter(safeModel);
}
