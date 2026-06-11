// SVG connector layer. Draws graceful Beziers from each queue row's connector
// dot to the central lens intake, and from the lens output to the active
// interlock spine node. Lines must terminate at real visible nodes — never
// floating curves. Recomputes positions on resize and on snapshot updates.

import { el, svg, setAttr } from './dom';

export interface ConnectorAnchor {
  identifier: string;
  node: HTMLElement;
  tone: string;
  focus: boolean;
}

export interface ConnectorsHandle {
  root: SVGElement;
  /** Update the queue → lens connectors. */
  updateQueueConnectors(anchors: ConnectorAnchor[], intake: HTMLElement | null): void;
  /** Update the lens → interlock connector. */
  updateInterlockConnector(output: HTMLElement | null, target: HTMLElement | null, tone: string): void;
  /** Update the lens → evidence circuit connector. */
  updateEvidenceConnector(junction: HTMLElement | null, target: HTMLElement | null): void;
  /** Resize hook (call on rAF when DOM ready). */
  recompute(): void;
}

export function mountConnectors(host: HTMLElement): ConnectorsHandle {
  const root = svg('svg', {
    class: 'lens-connectors',
    'aria-hidden': 'true',
    preserveAspectRatio: 'none'
  });
  const defs = svg('defs', {});
  // Define a soft pulse gradient for the focused path
  const grad = svg('linearGradient', { id: 'lens-conn-focus', x1: '0', y1: '0', x2: '1', y2: '0' });
  grad.appendChild(svg('stop', { offset: '0%', 'stop-color': '#5aaeff', 'stop-opacity': '0.0' }));
  grad.appendChild(svg('stop', { offset: '50%', 'stop-color': '#5ecbff', 'stop-opacity': '0.9' }));
  grad.appendChild(svg('stop', { offset: '100%', 'stop-color': '#5aaeff', 'stop-opacity': '0.0' }));
  defs.appendChild(grad);
  root.appendChild(defs);

  const queueGroup = svg('g', { class: 'lens-conn-queue' });
  const interlockGroup = svg('g', { class: 'lens-conn-interlock' });
  const evidenceGroup = svg('g', { class: 'lens-conn-evidence' });
  root.appendChild(queueGroup);
  root.appendChild(interlockGroup);
  root.appendChild(evidenceGroup);

  host.appendChild(root);

  let lastQueue: { anchors: ConnectorAnchor[]; intake: HTMLElement | null } = { anchors: [], intake: null };
  let lastInterlock: { output: HTMLElement | null; target: HTMLElement | null; tone: string } = { output: null, target: null, tone: 'amber' };
  let lastEvidence: { junction: HTMLElement | null; target: HTMLElement | null } = { junction: null, target: null };

  function center(node: Element): { x: number; y: number } | null {
    const rect = node.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - hostRect.left,
      y: rect.top + rect.height / 2 - hostRect.top
    };
  }

  function clearGroup(group: SVGElement) {
    while (group.firstChild) group.removeChild(group.firstChild);
  }

  function recompute() {
    const hostRect = host.getBoundingClientRect();
    setAttr(root, 'viewBox', `0 0 ${hostRect.width} ${hostRect.height}`);
    setAttr(root, 'width', String(hostRect.width));
    setAttr(root, 'height', String(hostRect.height));

    // Queue → intake
    clearGroup(queueGroup);
    if (lastQueue.intake) {
      const intakeCenter = center(lastQueue.intake);
      if (intakeCenter) {
        for (const anchor of lastQueue.anchors) {
          const dotCenter = center(anchor.node);
          if (!dotCenter) continue;
          const path = svg('path', {
            class: 'lens-conn-path',
            d: bezier(dotCenter, intakeCenter, 'right'),
            'data-tone': anchor.tone,
            'data-focus': anchor.focus ? 'true' : 'false'
          });
          queueGroup.appendChild(path);
        }
      }
    }

    // Lens output → interlock
    clearGroup(interlockGroup);
    if (lastInterlock.output && lastInterlock.target) {
      const a = center(lastInterlock.output);
      const b = center(lastInterlock.target);
      if (a && b) {
        const path = svg('path', {
          class: 'lens-conn-path lens-conn-interlock-path',
          d: bezier(a, b, 'left'),
          'data-tone': lastInterlock.tone
        });
        interlockGroup.appendChild(path);
      }
    }

    // Lens junction → evidence rail
    clearGroup(evidenceGroup);
    if (lastEvidence.junction && lastEvidence.target) {
      const a = center(lastEvidence.junction);
      const b = center(lastEvidence.target);
      if (a && b) {
        const path = svg('path', {
          class: 'lens-conn-path lens-conn-evidence-path',
          d: bezierVertical(a, b),
          'data-tone': 'green'
        });
        evidenceGroup.appendChild(path);
      }
    }
  }

  // Recompute on resize & font load
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => requestAnimationFrame(recompute), { passive: true });
    if (document.fonts && typeof document.fonts.ready === 'object') {
      document.fonts.ready.then(() => requestAnimationFrame(recompute)).catch(() => {});
    }
  }

  return {
    root,
    updateQueueConnectors(anchors, intake) {
      lastQueue = { anchors, intake };
      requestAnimationFrame(recompute);
    },
    updateInterlockConnector(output, target, tone) {
      lastInterlock = { output, target, tone };
      requestAnimationFrame(recompute);
    },
    updateEvidenceConnector(junction, target) {
      lastEvidence = { junction, target };
      requestAnimationFrame(recompute);
    },
    recompute
  };
}

function bezier(a: { x: number; y: number }, b: { x: number; y: number }, fromSide: 'left' | 'right'): string {
  const dx = (b.x - a.x);
  const controlOffset = Math.max(60, Math.abs(dx) * 0.6);
  const c1x = fromSide === 'right' ? a.x + controlOffset : a.x - controlOffset;
  const c2x = fromSide === 'right' ? b.x - controlOffset : b.x + controlOffset;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${c1x.toFixed(1)} ${a.y.toFixed(1)}, ${c2x.toFixed(1)} ${b.y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

function bezierVertical(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dy = (b.y - a.y);
  const offset = Math.max(40, Math.abs(dy) * 0.4);
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${a.x.toFixed(1)} ${(a.y + offset).toFixed(1)}, ${b.x.toFixed(1)} ${(b.y - offset).toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

export type _Unused = ReturnType<typeof el>;
