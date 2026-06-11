// Living Agent Lens — bootstrap. Mounts the full UI ONCE, then updates by
// mutating persistent DOM. Subscribes to /api/v1/events (SSE) for refresh
// pulses and re-fetches /api/v1/living-agent-lens.

import { el } from './dom';
import { mountShell } from './shell';
import { mountQueue } from './queue';
import { mountLens } from './lens';
import { mountInterlock } from './interlock';
import { mountEvidence } from './evidence';
import { mountDock } from './dock';
import { mountFooter } from './footer';
import { mountConnectors } from './connectors';
import { mountMissing } from './missing';
import { pulse, startMotionLoop, reducedMotion } from './motion';
import type { LensResponse } from './types';

export function startLens(root: HTMLElement) {
  // ── Static scaffold ──────────────────────────────────────────────────────
  const shell = mountShell();
  const queue = mountQueue();
  const lens = mountLens();
  const interlock = mountInterlock();
  const evidence = mountEvidence();
  const dock = mountDock();
  const footer = mountFooter();
  const missing = mountMissing();

  const stage = el(
    'div',
    { class: 'lens-stage-grid' },
    queue.root,
    lens.root,
    interlock.root
  );

  const lower = el('div', { class: 'lens-lower' }, evidence.root, dock.root);
  const app = el(
    'main',
    { class: 'lens-app', 'data-reduced-motion': reducedMotion() ? 'true' : 'false' },
    shell.root,
    missing.root,
    stage,
    lower,
    footer.root
  );

  const connectorsHost = el('div', { class: 'lens-connectors-host', 'aria-hidden': 'true' });
  app.insertBefore(connectorsHost, app.firstChild);
  const connectors = mountConnectors(connectorsHost);

  root.appendChild(app);

  // ── State ───────────────────────────────────────────────────────────────
  // Seed focusIdentifier from the page URL so /lens?focus_issue=NIE-300 lands
  // on the requested issue on first fetch (otherwise the projector falls back
  // to top-of-gravity ordering).
  const pageUrl = new URL(window.location.href);
  let focusIdentifier: string | null = pageUrl.searchParams.get('focus_issue');
  let lastResponse: LensResponse | null = null;
  let refreshTimer: number | null = null;
  let inFlight = false;

  function setStatus(state: 'live' | 'polling' | 'stale' | 'offline') {
    app.dataset.transport = state;
  }

  async function fetchLens() {
    if (inFlight) return;
    inFlight = true;
    try {
      const url = new URL('/api/v1/living-agent-lens', window.location.origin);
      if (focusIdentifier) url.searchParams.set('focus_issue', focusIdentifier);
      const transport = app.dataset.transport ?? 'polling';
      url.searchParams.set('transport', transport);
      const res = await fetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) {
        setStatus('offline');
        return;
      }
      const data = (await res.json()) as LensResponse;
      apply(data);
    } catch {
      setStatus('offline');
    } finally {
      inFlight = false;
    }
  }

  function apply(data: LensResponse) {
    lastResponse = data;
    // Pin focus to whatever the server says, so explicit selection from the
    // URL or queue stays consistent across refreshes.
    const newFocus = data.focus?.issue_identifier ?? null;
    if (newFocus) focusIdentifier = newFocus;
    shell.update(data.shell);
    const filtersGap = data.missing_capabilities.find((m) => m.id === 'shell_smart_filters');
    shell.setFiltersEnabled(!filtersGap, filtersGap?.current_fallback ?? null);
    missing.update(data.missing_capabilities);
    queue.update(data.queue, focusIdentifier);
    lens.update(data.focus, data.lens);
    interlock.update(data.interlocks);
    evidence.update(data.evidence_path);
    dock.update(data.actions);
    footer.update(data.footer);
    // Connector anchors
    const queueAnchors = data.queue
      .map((row) => {
        const node = queue.connectorDot(row.issue_identifier);
        return node
          ? { identifier: row.issue_identifier, node, tone: toneForRow(row.state), focus: row.is_focus }
          : null;
      })
      .filter((a): a is { identifier: string; node: HTMLElement; tone: string; focus: boolean } => a !== null);
    connectors.updateQueueConnectors(queueAnchors, lens.intakeNode);
    const activeInterlockNode = (interlock.root.querySelector('.lens-spine-node[data-tone="amber"], .lens-spine-node[data-tone="red"], .lens-spine-node[data-tone="green"]') as HTMLElement | null)
      ?? (interlock.root.querySelector('.lens-spine-node') as HTMLElement | null);
    connectors.updateInterlockConnector(lens.outputNode, activeInterlockNode, data.interlocks[0]?.tone ?? 'amber');
    const evidenceTargetNode = evidence.root.querySelector('.lens-evidence-pill[data-evidence-id="thread"]') as HTMLElement | null;
    connectors.updateEvidenceConnector(lens.evidenceJunction, evidenceTargetNode);

    setStatus(transportFromState(data));
    // Pulse the refresh cell as a one-shot — never disturbs neighboring layout.
    const refreshCell = shell.root.querySelector('.lens-cell[data-cell="refresh_pulse"]');
    if (refreshCell) pulse(refreshCell, 'lens-cell-pulse', 720);
  }

  function transportFromState(data: LensResponse): 'live' | 'polling' | 'stale' | 'offline' {
    if (data.snapshot_freshness.state === 'stale') return 'stale';
    if (data.snapshot_freshness.transport === 'stream') return 'live';
    return 'polling';
  }

  function toneForRow(state: string): string {
    switch (state) {
      case 'focus':
      case 'running':
        return 'blue';
      case 'review':
        return 'amber';
      case 'retry':
        return 'amber';
      case 'warning':
        return 'amber';
      case 'blocked':
        return 'red';
      default:
        return 'neutral';
    }
  }

  // ── Interactivity ───────────────────────────────────────────────────────

  // Telemetry-ribbon cells open their detail_endpoint in a new tab. Cells
  // without an endpoint render disabled (handled in shell.ts) so we never act
  // on an inert button. Filters is wired separately: enabled only when the
  // projector reports no `shell_smart_filters` missing capability.
  shell.root.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const cell = target.closest('.lens-cell') as HTMLButtonElement | null;
    if (cell) {
      if (cell.getAttribute('aria-disabled') === 'true' || cell.disabled) return;
      const endpoint = cell.getAttribute('data-endpoint');
      if (endpoint) window.open(endpoint, '_blank', 'noopener');
      return;
    }
    const filtersBtn = target.closest('[data-action="open-filters"]') as HTMLButtonElement | null;
    if (filtersBtn) {
      if (filtersBtn.getAttribute('aria-disabled') === 'true' || filtersBtn.disabled) return;
      // Real smart-filter UI is not yet implemented; surface the missing-gaps
      // panel as the honest next step instead of opening a fake surface.
      const chip = missing.root.querySelector('.lens-missing-chip') as HTMLButtonElement | null;
      chip?.click();
    }
  });

  queue.onSelect((identifier) => {
    focusIdentifier = identifier;
    try {
      const next = new URL(window.location.href);
      next.searchParams.set('focus_issue', identifier);
      window.history.replaceState(null, '', next.toString());
    } catch {
      // ignore — focus state still applies via fetchLens()
    }
    void fetchLens();
  });

  // Hover a queue row → brighten the matching connector path (state, evidence,
  // and interlock alignment is a deliberate spec interaction).
  queue.root.addEventListener('pointerover', (event) => {
    const row = (event.target as Element | null)?.closest('[data-issue-row]') as HTMLElement | null;
    if (!row) return;
    const id = row.getAttribute('data-issue-row');
    if (!id) return;
    connectors.root.querySelectorAll('[data-tone]').forEach((node) => node.removeAttribute('data-hover'));
    const dot = queue.connectorDot(id);
    if (!dot) return;
    const dotRect = dot.getBoundingClientRect();
    // Find the path that starts closest to this dot's y coordinate.
    const paths = connectors.root.querySelectorAll('.lens-conn-queue .lens-conn-path');
    let best: Element | null = null;
    let bestDelta = Infinity;
    paths.forEach((path) => {
      const m = path.getAttribute('d')?.match(/^M\s*([\d.]+)\s+([\d.]+)/);
      if (!m) return;
      const py = parseFloat(m[2]);
      const delta = Math.abs(py - (dotRect.top + dotRect.height / 2 - connectors.root.getBoundingClientRect().top));
      if (delta < bestDelta) {
        bestDelta = delta;
        best = path;
      }
    });
    if (best) (best as Element).setAttribute('data-hover', 'true');
  });
  queue.root.addEventListener('pointerleave', () => {
    connectors.root.querySelectorAll('[data-hover]').forEach((n) => n.removeAttribute('data-hover'));
  });

  lens.onEventSelected(() => {
    // Inspectors are scoped to the existing /api routes via popovers; for
    // pixel-faithful build we surface the existing diagnostics endpoint.
    if (!lastResponse?.focus) return;
    window.open(`/api/v1/issues/${encodeURIComponent(lastResponse.focus.issue_identifier)}/diagnostics`, '_blank');
  });

  lens.onMessageOpen(() => {
    if (!lastResponse?.focus) return;
    window.open(`/api/v1/issues/${encodeURIComponent(lastResponse.focus.issue_identifier)}`, '_blank');
  });

  evidence.onOpen((id) => {
    if (!lastResponse) return;
    const node = lastResponse.evidence_path.find((n) => n.id === id);
    if (node?.open_endpoint) window.open(node.open_endpoint, '_blank');
  });

  evidence.onCopy((id) => {
    if (!lastResponse) return;
    const node = lastResponse.evidence_path.find((n) => n.id === id);
    if (node?.copy_value && navigator.clipboard) {
      void navigator.clipboard.writeText(node.copy_value);
    }
  });

  dock.onActivate((id) => {
    if (id === 'inspect_evidence') {
      evidence.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (id === 'export_forensics' && lastResponse?.focus) {
      window.open(`/api/v1/issues/${encodeURIComponent(lastResponse.focus.issue_identifier)}/forensics/export`, '_blank');
      return;
    }
    if (id === 'drain_wait') {
      // Surface drain mode endpoint
      window.open('/api/v1/drain-mode', '_blank');
      return;
    }
    // Steer / Resume — focus the interlock spine card 2 for composer entry.
    const card = interlock.root.querySelector('.lens-spine-card[data-step="intent"]') as HTMLElement | null;
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.focus({ preventScroll: true });
      card.classList.add('lens-spine-card-attention');
      setTimeout(() => card.classList.remove('lens-spine-card-attention'), 1400);
    }
  });

  dock.onMoreItem((_itemId, endpoint) => {
    if (endpoint) window.open(endpoint, '_blank');
  });

  // ── Refresh loop + SSE ──────────────────────────────────────────────────
  function scheduleRefresh() {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void fetchLens(), 1200);
  }

  window.addEventListener('focus', () => void fetchLens());

  let stream: EventSource | null = null;
  try {
    stream = new EventSource('/api/v1/events');
    stream.addEventListener('open', () => setStatus('live'));
    stream.addEventListener('error', () => setStatus('polling'));
    stream.addEventListener('message', (ev) => {
      try {
        const envelope = JSON.parse((ev as MessageEvent).data) as { type: string };
        if (envelope.type === 'state_snapshot' || envelope.type === 'refresh_accepted' || envelope.type === 'heartbeat') {
          void fetchLens();
        }
      } catch {
        // ignore parse errors
      }
    });
  } catch {
    setStatus('polling');
  }

  // Initial fetch + a slow safety re-poll.
  void fetchLens();
  setInterval(() => void fetchLens(), 5000);

  startMotionLoop();
  // Recompute connectors after fonts/layout settle.
  requestAnimationFrame(() => connectors.recompute());
  setTimeout(() => connectors.recompute(), 600);

  // Pin scheduleRefresh so it isn't tree-shaken (the function is reserved for
  // future operator-action wiring).
  void scheduleRefresh;
}
