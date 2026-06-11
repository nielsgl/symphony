// Interlock Spine — right column: 4 cards in sequence (Preconditions, Safe
// Intervention, Endpoint Preview, Audit Receipt), threaded by a vertical
// light rail of spine nodes. Each card mutates in place to avoid remount.

import { el, setAttr, setText, clear } from './dom';
import type { InterlockStep, InterlockBody } from './types';

export interface InterlockHandle {
  root: HTMLElement;
  update(steps: InterlockStep[]): void;
}

export function mountInterlock(): InterlockHandle {
  const rail = el('div', { class: 'lens-spine-rail', 'aria-hidden': 'true' });
  const railNodes = [1, 2, 3, 4].map((idx) => {
    const node = el('span', { class: 'lens-spine-node', 'data-index': String(idx) });
    rail.appendChild(node);
    return node;
  });

  const cards: CardHandle[] = [1, 2, 3, 4].map((idx) => createCard(idx as 1 | 2 | 3 | 4));
  const stack = el('div', { class: 'lens-spine-stack' }, ...cards.map((c) => c.root));

  const root = el(
    'section',
    { class: 'lens-interlock-column', 'aria-labelledby': 'lens-interlock-heading' },
    el(
      'header',
      { class: 'lens-column-head' },
      el('p', { class: 'lens-eyebrow' }, 'Interlock Spine'),
      el('h2', { id: 'lens-interlock-heading', class: 'lens-column-title' }, 'Safety before every command')
    ),
    el('div', { class: 'lens-spine-shell' }, rail, stack)
  );

  return {
    root,
    update(steps) {
      steps.forEach((step, idx) => {
        cards[idx]?.update(step);
        const node = railNodes[idx];
        if (node) {
          setAttr(node, 'data-tone', step.tone);
          setAttr(node, 'aria-hidden', 'true');
        }
      });
    }
  };
}

interface CardHandle {
  root: HTMLElement;
  update(step: InterlockStep): void;
}

function createCard(index: 1 | 2 | 3 | 4): CardHandle {
  const title = el('h3', { class: 'lens-spine-title' });
  const subtitle = el('p', { class: 'lens-spine-subtitle' });
  const stateLabel = el('span', { class: 'lens-spine-state' });
  const bodyHost = el('div', { class: 'lens-spine-body' });
  const root = el(
    'article',
    {
      class: 'lens-spine-card',
      'data-index': String(index),
      role: 'group',
      'aria-labelledby': `lens-spine-title-${index}`
    },
    el('header', { class: 'lens-spine-head' }, title, stateLabel),
    subtitle,
    bodyHost
  );
  title.setAttribute('id', `lens-spine-title-${index}`);

  return {
    root,
    update(step) {
      setText(title, step.title);
      setText(subtitle, step.subtitle);
      setText(stateLabel, step.state_label);
      setAttr(root, 'data-tone', step.tone);
      setAttr(root, 'data-step', step.id);
      renderBody(bodyHost, step.body);
    }
  };
}

function renderBody(host: HTMLElement, body: InterlockBody) {
  // Preserve identity when kind doesn't change so transitions are smooth.
  const currentKind = host.getAttribute('data-kind');
  if (currentKind !== body.kind) {
    clear(host);
    setAttr(host, 'data-kind', body.kind);
    if (body.kind === 'preconditions') host.appendChild(el('ul', { class: 'lens-precond-list', role: 'list' }));
    else if (body.kind === 'intent') host.appendChild(buildIntent(body));
    else if (body.kind === 'preview') host.appendChild(buildPreview(body));
    else if (body.kind === 'receipt') host.appendChild(buildReceipt(body));
    if (body.kind !== 'preconditions') return;
  }
  if (body.kind === 'preconditions') {
    const list = host.firstElementChild as HTMLElement | null;
    if (!list) return;
    clear(list);
    for (const check of body.checks) {
      list.appendChild(
        el(
          'li',
          { class: 'lens-precond-item', 'data-ok': check.ok ? 'true' : 'false' },
          el('span', { class: 'lens-precond-dot', 'aria-hidden': 'true' }),
          el('div', { class: 'lens-precond-text' },
            el('span', { class: 'lens-precond-label' }, check.label),
            check.detail ? el('span', { class: 'lens-precond-detail' }, check.detail) : null
          )
        )
      );
    }
  } else if (body.kind === 'intent') {
    const capsule = host.querySelector('.lens-intent-capsule') as HTMLElement | null;
    if (capsule) setText(capsule, body.intent_capsule);
  } else if (body.kind === 'preview') {
    const code = host.querySelector('.lens-preview-code') as HTMLElement | null;
    const endpointLabel = host.querySelector('.lens-preview-endpoint') as HTMLElement | null;
    if (code) setText(code, body.body_preview ?? '— (preview unavailable)');
    if (endpointLabel) setText(endpointLabel, body.endpoint ? `${body.method ?? 'POST'} ${body.endpoint}` : 'No request');
  } else if (body.kind === 'receipt') {
    const lifecycle = host.querySelector('.lens-receipt-lifecycle') as HTMLElement | null;
    const id = host.querySelector('.lens-receipt-id') as HTMLElement | null;
    const result = host.querySelector('.lens-receipt-result') as HTMLElement | null;
    if (lifecycle) setText(lifecycle, body.lifecycle);
    if (id) setText(id, body.receipt_id ?? '—');
    if (result) setText(result, body.result ?? (body.lifecycle === 'preview' ? 'Will create receipt on send' : ''));
  }
}

function buildIntent(body: Extract<InterlockBody, { kind: 'intent' }>): HTMLElement {
  return el(
    'div',
    { class: 'lens-intent' },
    el('span', { class: 'lens-intent-capsule' }, body.intent_capsule),
    body.reason_note_required
      ? el('span', { class: 'lens-intent-reason' }, 'Reason note required')
      : null
  );
}

function buildPreview(body: Extract<InterlockBody, { kind: 'preview' }>): HTMLElement {
  return el(
    'div',
    { class: 'lens-preview' },
    el('span', { class: 'lens-preview-endpoint' }, body.endpoint ? `${body.method ?? 'POST'} ${body.endpoint}` : 'No request'),
    el('pre', { class: 'lens-preview-code' }, body.body_preview ?? '— (preview unavailable)')
  );
}

function buildReceipt(body: Extract<InterlockBody, { kind: 'receipt' }>): HTMLElement {
  return el(
    'div',
    { class: 'lens-receipt' },
    el('div', { class: 'lens-receipt-head' },
      el('span', { class: 'lens-receipt-id' }, body.receipt_id ?? '—'),
      el('span', { class: 'lens-receipt-lifecycle' }, body.lifecycle)
    ),
    el('span', { class: 'lens-receipt-result' }, body.result ?? '')
  );
}
