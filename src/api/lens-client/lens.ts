// Living Agent Lens — the central spatial instrument.
// Mounted ONCE; updated by mutating text/attrs of persistent nodes so the
// breathing/orbit/star-field animations never reset on snapshot refresh.

import { el, setAttr, setText, svg, clear } from './dom';
import { icon } from './icons';
import { phase, registerAnimation } from './motion';
import type { EvidenceNode, FocusRun, LensTelemetry } from './types';

export interface LensHandle {
  root: HTMLElement;
  update(focus: FocusRun | null, lens: LensTelemetry | null): void;
  /** Intake node (where left queue connectors converge). */
  intakeNode: HTMLElement;
  /** Output node (where right interlock connector originates). */
  outputNode: HTMLElement;
  /** Evidence path junction (bottom). */
  evidenceJunction: HTMLElement;
  onEventSelected(handler: (eventId: string) => void): void;
  onMessageOpen(handler: () => void): void;
}

export function mountLens(): LensHandle {
  const stage = el('div', { class: 'lens-stage', role: 'group', 'aria-label': 'Living Agent Lens' });

  // Star field — always-on background drift driven by CSS.
  const starField = mountStarField();
  stage.appendChild(starField);

  // Concentric ring stack: outer aura, ring, dotted orbit, inner ticks.
  const lensCircle = el('div', { class: 'lens-circle', 'aria-hidden': 'true' });
  const outerAura = el('div', { class: 'lens-aura' });
  const outerRing = el('div', { class: 'lens-ring lens-ring-outer' });
  const dottedRing = el('div', { class: 'lens-ring lens-ring-dotted' });
  const innerRing = el('div', { class: 'lens-ring lens-ring-inner' });
  const nucleus = el('div', { class: 'lens-nucleus' });
  lensCircle.append(outerAura, outerRing, dottedRing, innerRing, nucleus);
  stage.appendChild(lensCircle);

  // Focus crown
  const crownId = el('span', { class: 'lens-crown-id' });
  const crownTitle = el('span', { class: 'lens-crown-title' });
  const crownRun = el('span', { class: 'lens-crown-run' }, el('span', { class: 'lens-crown-dot' }), el('span', { class: 'lens-crown-run-text' }, 'Run Attempt #—'));
  const crown = el(
    'button',
    { type: 'button', class: 'lens-crown', 'aria-label': 'Focused run identity' },
    crownId,
    crownTitle,
    crownRun
  );
  stage.appendChild(crown);

  // Live refresh micro-indicator (left of lens)
  const liveLabel = el('span', { class: 'lens-live-label' }, 'LIVE REFRESH');
  const oscillo = svg(
    'svg',
    { class: 'lens-oscillo', viewBox: '0 0 80 24', 'aria-hidden': 'true' },
    svg('polyline', { class: 'lens-oscillo-line', points: '0,12 8,12 12,4 16,20 20,8 24,16 28,12 80,12', fill: 'none' })
  );
  const liveValue = el('span', { class: 'lens-live-value' }, '—');
  const liveMicro = el('div', { class: 'lens-live-micro' }, liveLabel, oscillo, liveValue);
  stage.appendChild(liveMicro);

  // Transcript confidence (upper-right of lens)
  const tcLabel = el('span', { class: 'lens-tc-label' }, 'TRANSCRIPT CONFIDENCE');
  const tcScore = el('span', { class: 'lens-tc-score' }, '—');
  const tcQual = el('span', { class: 'lens-tc-qual' }, 'unavailable');
  const transcriptConfidence = el(
    'button',
    { type: 'button', class: 'lens-transcript-confidence', 'aria-label': 'Open transcript confidence inspector' },
    tcLabel,
    el('div', { class: 'lens-tc-row' }, tcScore, tcQual)
  );
  stage.appendChild(transcriptConfidence);

  // Current message card (left-center inside ring)
  const msgRole = el('span', { class: 'lens-msg-role' }, 'role: —');
  const msgExcerpt = el('p', { class: 'lens-msg-excerpt' });
  const msgTime = el('span', { class: 'lens-msg-time' });
  const msgDots = el('div', { class: 'lens-msg-dots', 'aria-hidden': 'true' }, el('span'), el('span'));
  const currentMessage = el(
    'button',
    { type: 'button', class: 'lens-current-message', 'aria-label': 'Open current message inspector' },
    el('span', { class: 'lens-eyebrow lens-msg-eyebrow' }, 'CURRENT MESSAGE'),
    msgRole,
    msgExcerpt,
    el('div', { class: 'lens-msg-foot' }, msgTime, msgDots)
  );
  stage.appendChild(currentMessage);

  // Role stream (lower-left inside lens)
  const roleStreamHost = el('div', { class: 'lens-role-streams', role: 'group', 'aria-label': 'Role stream (last 12)' });
  const roleStream = el(
    'div',
    { class: 'lens-role-stream' },
    el('span', { class: 'lens-eyebrow lens-role-eyebrow' }, 'ROLE STREAM (LAST 12)'),
    roleStreamHost
  );
  stage.appendChild(roleStream);

  // Event orbit (right side, orbiting nucleus). We render a fixed-size shell
  // with up to 6 slots; nodes are reused by id.
  const orbitTrack = el('ol', { class: 'lens-event-orbit', role: 'list' });
  stage.appendChild(orbitTrack);
  const orbitNodes = new Map<string, OrbitNodeHandle>();
  let eventHandlers: Array<(id: string) => void> = [];

  // Bounded window (lower center inside lens)
  const ctxBar = el('div', { class: 'lens-ctx-bar' });
  const ctxDetail = el('span', { class: 'lens-ctx-detail' });
  const ctxLock = icon('shield-check', { size: 12, class: 'lens-ctx-lock' });
  const contextWindow = el(
    'button',
    { type: 'button', class: 'lens-context-window', 'aria-label': 'Open bounded-window inspector' },
    el('span', { class: 'lens-eyebrow' }, 'BOUNDED WINDOW'),
    el('div', { class: 'lens-ctx-row' }, el('span', { class: 'lens-ctx-cap' }, '— messages'), ctxLock),
    ctxBar,
    ctxDetail
  );
  stage.appendChild(contextWindow);

  // Connector anchors
  const intakeNode = el('span', { class: 'lens-intake-node', 'aria-hidden': 'true' });
  const outputNode = el('span', { class: 'lens-output-node', 'aria-hidden': 'true' });
  const evidenceJunction = el('span', { class: 'lens-evidence-junction', 'aria-hidden': 'true' });
  stage.append(intakeNode, outputNode, evidenceJunction);

  // Rotate the orbit slowly via a JS-driven transform that uses a stable
  // monotonic phase so refreshes never reset.
  registerAnimation(() => {
    // Outer slow rotation
    const slow = phase(38);
    orbitTrack.style.setProperty('--lens-orbit-phase', String(slow));
    // Nucleus shimmer
    nucleus.style.setProperty('--lens-shimmer', String(phase(7)));
  });

  // Event delegation for orbit clicks
  orbitTrack.addEventListener('click', (event) => {
    const target = (event.target as Element | null)?.closest('[data-orbit-id]') as HTMLElement | null;
    if (!target) return;
    const id = target.getAttribute('data-orbit-id');
    if (id) eventHandlers.forEach((h) => h(id));
  });

  const root = el(
    'section',
    { class: 'lens-center-column', 'aria-label': 'Living Agent Lens' },
    stage
  );

  let messageOpenHandlers: Array<() => void> = [];
  currentMessage.addEventListener('click', () => messageOpenHandlers.forEach((h) => h()));

  return {
    root,
    intakeNode,
    outputNode,
    evidenceJunction,
    onEventSelected(handler) { eventHandlers.push(handler); },
    onMessageOpen(handler) { messageOpenHandlers.push(handler); },
    update(focus, lens) {
      const hasFocus = !!focus && !!lens;
      stage.classList.toggle('lens-stage-empty', !hasFocus);
      // Crown
      setText(crownId, focus ? focus.issue_identifier : '—');
      setText(crownTitle, focus ? focus.title : 'No focus selected');
      const runText = crownRun.querySelector('.lens-crown-run-text') as HTMLElement;
      setText(runText, focus ? `Run Attempt #${focus.run_attempt}` : 'Run Attempt #—');
      setAttr(crown, 'data-has-focus', hasFocus ? 'true' : 'false');
      // Ring tone
      setAttr(lensCircle, 'data-tone', lens?.ring_tone ?? 'neutral');
      // Current message
      if (lens?.current_message) {
        const cm = lens.current_message;
        setText(msgRole, `role: ${cm.role}`);
        setText(msgExcerpt, cm.excerpt);
        setText(msgTime, formatTime(cm.at));
        currentMessage.classList.remove('lens-card-empty');
      } else {
        setText(msgRole, 'role: —');
        setText(msgExcerpt, focus ? 'Waiting for next message…' : 'Select an issue to see live messages.');
        setText(msgTime, '');
        currentMessage.classList.add('lens-card-empty');
      }
      // Role stream
      updateRoleStream(roleStreamHost, lens?.role_stream ?? null);
      // Event orbit
      updateEventOrbit(orbitTrack, orbitNodes, lens?.events ?? []);
      // Context window
      const ctx = lens?.context_window;
      const cap = contextWindow.querySelector('.lens-ctx-cap') as HTMLElement;
      if (ctx) {
        setText(cap, `${ctx.limit} messages`);
        const visible = ctx.visible_messages;
        const clipped = ctx.clipped_messages;
        const pct = ctx.limit > 0 ? Math.min(1, visible / ctx.limit) : 0;
        ctxBar.style.setProperty('--lens-ctx-fill', String(pct));
        setText(ctxDetail, ctx.scan_budget_state === 'unknown'
          ? `${visible} visible · ${clipped} clipped (window state unavailable)`
          : `${visible} visible · ${clipped} clipped`);
        setAttr(contextWindow, 'data-scan-state', ctx.scan_budget_state);
      } else {
        setText(cap, '— messages');
        ctxBar.style.setProperty('--lens-ctx-fill', '0');
        setText(ctxDetail, 'No focus selected');
      }
      // Transcript confidence
      if (lens) {
        setText(tcScore, lens.transcript_confidence.score.toFixed(2));
        setText(tcQual, lens.transcript_confidence.label);
        setAttr(transcriptConfidence, 'data-label', lens.transcript_confidence.label);
      } else {
        setText(tcScore, '—');
        setText(tcQual, 'unavailable');
        setAttr(transcriptConfidence, 'data-label', 'unavailable');
      }
    }
  };
}

function mountStarField(): HTMLElement {
  const field = el('div', { class: 'lens-starfield', 'aria-hidden': 'true' });
  // Render 60 stars at static positions; their drift is CSS-driven.
  for (let i = 0; i < 60; i++) {
    const star = el('span', { class: 'lens-star' });
    const x = (i * 137) % 100;
    const y = (i * 73) % 100;
    star.style.left = `${x}%`;
    star.style.top = `${y}%`;
    star.style.setProperty('--lens-star-delay', `${(i * 0.31) % 6}s`);
    star.style.setProperty('--lens-star-size', `${((i * 7) % 3) + 1}px`);
    field.appendChild(star);
  }
  return field;
}

interface OrbitNodeHandle {
  root: HTMLLIElement;
  update(event: NonNullable<LensTelemetry['events']>[number], slot: number, total: number): void;
}

const MAX_ORBIT = 6;

function updateEventOrbit(
  track: HTMLElement,
  nodes: Map<string, OrbitNodeHandle>,
  events: NonNullable<LensTelemetry['events']>
) {
  const visible = events.slice(0, MAX_ORBIT);
  const seen = new Set<string>();
  visible.forEach((event, idx) => {
    seen.add(event.id);
    let handle = nodes.get(event.id);
    if (!handle) {
      handle = createOrbitNode();
      nodes.set(event.id, handle);
      handle.root.classList.add('lens-orbit-enter');
      setTimeout(() => handle?.root.classList.remove('lens-orbit-enter'), 480);
    }
    if (handle.root.parentElement !== track) {
      track.appendChild(handle.root);
    }
    handle.update(event, idx, visible.length);
  });
  for (const [id, handle] of nodes) {
    if (!seen.has(id)) {
      handle.root.classList.add('lens-orbit-leave');
      setTimeout(() => {
        if (handle.root.isConnected) handle.root.remove();
        nodes.delete(id);
      }, 480);
    }
  }
}

function createOrbitNode(): OrbitNodeHandle {
  const iconHost = el('span', { class: 'lens-orbit-icon', 'aria-hidden': 'true' });
  const label = el('span', { class: 'lens-orbit-label' });
  const time = el('span', { class: 'lens-orbit-time' });
  const root = el(
    'li',
    { class: 'lens-orbit-node', tabindex: '0', role: 'button', 'data-orbit-id': '' },
    iconHost,
    el('span', { class: 'lens-orbit-text' }, label, time)
  ) as HTMLLIElement;
  return {
    root,
    update(event, slot, total) {
      setAttr(root, 'data-orbit-id', event.id);
      setAttr(root, 'data-tone', event.tone);
      setAttr(root, 'data-category', event.category);
      setAttr(root, 'data-slot', String(slot));
      setAttr(root, 'data-total', String(total));
      // Distribute on the RIGHT half of the lens (≈-65° → +65° measured from
      // the 3 o'clock axis) so orbit nodes don't collide with the message
      // card on the left or the role-stream block in the lower-left.
      const span = 140;
      const offsetDeg = total > 1 ? -65 + (slot / (total - 1)) * span : 0;
      root.style.setProperty('--lens-orbit-slot', String(offsetDeg));
      iconHost.replaceChildren(icon(event.icon || 'wrench', { size: 14 }));
      setText(label, event.label);
      setText(time, formatTime(event.at));
      setAttr(root, 'aria-label', `${event.category} ${event.label} at ${formatTime(event.at)}`);
    }
  };
}

function updateRoleStream(host: HTMLElement, stream: LensTelemetry['role_stream'] | null) {
  if (!stream) {
    clear(host);
    host.appendChild(el('span', { class: 'lens-role-empty' }, 'role data unavailable'));
    return;
  }
  // Build once, then update counts.
  if (host.childElementCount !== stream.segments.length) {
    clear(host);
    for (const segment of stream.segments) {
      const node = el(
        'div',
        { class: 'lens-role-segment', 'data-role': segment.role, 'data-tone': segment.tone },
        el('span', { class: 'lens-role-name' }, segment.role),
        el('span', { class: 'lens-role-count' }, String(segment.count))
      );
      host.appendChild(node);
    }
    return;
  }
  Array.from(host.children).forEach((child, idx) => {
    const segment = stream.segments[idx];
    if (!segment) return;
    setAttr(child as Element, 'data-tone', segment.tone);
    const count = child.querySelector('.lens-role-count') as HTMLElement | null;
    if (count) setText(count, String(segment.count));
  });
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const d = new Date(parsed);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export type _EvidenceUnused = EvidenceNode;
