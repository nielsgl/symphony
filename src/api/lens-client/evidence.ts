// Evidence Path — beneath the lens. Renders thread / transcript / api snapshot
// / audit pills plus the lower controls (path capsule, View button, snapshot).

import { el, setAttr, setText } from './dom';
import type { EvidenceNode } from './types';

export interface EvidenceHandle {
  root: HTMLElement;
  update(nodes: EvidenceNode[]): void;
  onOpen(handler: (id: EvidenceNode['id']) => void): void;
  onCopy(handler: (id: EvidenceNode['id']) => void): void;
}

export function mountEvidence(): EvidenceHandle {
  const rail = el('div', { class: 'lens-evidence-rail', role: 'list', 'aria-label': 'Evidence path' });

  const handles = new Map<EvidenceNode['id'], EvidencePillHandle>();
  for (const id of ['thread', 'transcript', 'api_snapshot', 'audit'] as const) {
    const handle = createPill(id);
    handles.set(id, handle);
    rail.appendChild(handle.root);
  }

  const pathCapsule = el('span', { class: 'lens-evidence-path-capsule' }, '—');
  const viewButton = el('button', { type: 'button', class: 'lens-evidence-view' }, 'View');
  const snapshotCapsule = el('span', { class: 'lens-evidence-snapshot' }, 'api snapshot');
  const lower = el(
    'div',
    { class: 'lens-evidence-lower' },
    pathCapsule,
    viewButton,
    snapshotCapsule
  );

  const root = el('section', { class: 'lens-evidence', 'aria-label': 'Evidence path' }, rail, lower);

  const openHandlers: Array<(id: EvidenceNode['id']) => void> = [];
  const copyHandlers: Array<(id: EvidenceNode['id']) => void> = [];

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const pill = target.closest('[data-evidence-id]') as HTMLElement | null;
    if (pill) {
      const id = pill.getAttribute('data-evidence-id') as EvidenceNode['id'] | null;
      const action = target.closest('[data-evidence-action]')?.getAttribute('data-evidence-action');
      if (id) {
        if (action === 'copy') copyHandlers.forEach((h) => h(id));
        else openHandlers.forEach((h) => h(id));
      }
    } else if (target.classList.contains('lens-evidence-view')) {
      openHandlers.forEach((h) => h('transcript'));
    }
  });

  return {
    root,
    onOpen(handler) { openHandlers.push(handler); },
    onCopy(handler) { copyHandlers.push(handler); },
    update(nodes) {
      const transcript = nodes.find((n) => n.id === 'transcript');
      setText(pathCapsule, transcript?.value ?? '—');
      setAttr(viewButton, 'disabled', transcript?.open_endpoint ? null : 'true');
      const apiSnap = nodes.find((n) => n.id === 'api_snapshot');
      setText(snapshotCapsule, apiSnap?.value ?? 'api snapshot');
      setAttr(snapshotCapsule, 'data-tone', apiSnap?.tone ?? 'gray');
      for (const node of nodes) {
        const handle = handles.get(node.id);
        if (handle) handle.update(node);
      }
    }
  };
}

interface EvidencePillHandle {
  root: HTMLElement;
  update(node: EvidenceNode): void;
}

function createPill(id: EvidenceNode['id']): EvidencePillHandle {
  const label = el('span', { class: 'lens-evidence-label' }, id);
  const value = el('span', { class: 'lens-evidence-value' });
  const detail = el('span', { class: 'lens-evidence-detail' });
  const copyBtn = el(
    'button',
    { type: 'button', class: 'lens-evidence-copy', 'data-evidence-action': 'copy', 'aria-label': `Copy ${id}` },
    'copy'
  );
  const root = el(
    'button',
    {
      type: 'button',
      class: 'lens-evidence-pill',
      'data-evidence-id': id,
      role: 'listitem',
      'aria-label': `Open ${id} evidence`
    },
    label,
    value,
    detail,
    copyBtn
  );
  return {
    root,
    update(node) {
      setText(value, node.value);
      setText(detail, node.detail ?? '');
      setAttr(root, 'data-tone', node.tone);
      setAttr(root, 'aria-label', `${node.label}: ${node.value}${node.detail ? ` — ${node.detail}` : ''}`);
      setAttr(copyBtn, 'disabled', node.copy_value ? null : 'true');
    }
  };
}
