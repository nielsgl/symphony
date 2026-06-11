// Missing Capabilities surface. Per the spec's loophole audit:
// "No evidence node, checkmark, receipt, or safety state may be green unless
//  the backend proves it." We surface backend gaps as a quiet amber chip that
//  expands into a list.

import { el, setAttr, setText, clear } from './dom';
import type { MissingCapability } from './types';

export interface MissingHandle {
  root: HTMLElement;
  update(items: MissingCapability[]): void;
}

export function mountMissing(): MissingHandle {
  const count = el('span', { class: 'lens-missing-count' }, '0');
  const summary = el('span', { class: 'lens-missing-summary' }, 'Honest gaps');
  const chip = el(
    'button',
    {
      type: 'button',
      class: 'lens-missing-chip',
      'aria-expanded': 'false',
      'aria-controls': 'lens-missing-panel'
    },
    summary,
    count
  );
  const panel = el('div', {
    class: 'lens-missing-panel hidden',
    id: 'lens-missing-panel',
    role: 'region',
    'aria-label': 'Missing backend capabilities'
  });

  chip.addEventListener('click', () => {
    const open = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', open);
    setAttr(chip, 'aria-expanded', open ? 'false' : 'true');
  });

  const root = el('div', { class: 'lens-missing' }, chip, panel);

  return {
    root,
    update(items) {
      setText(count, String(items.length));
      setAttr(root, 'data-empty', items.length === 0 ? 'true' : 'false');
      clear(panel);
      if (items.length === 0) {
        panel.appendChild(el('p', { class: 'lens-missing-empty' }, 'All UI claims are backed by live signals.'));
        return;
      }
      for (const item of items) {
        panel.appendChild(
          el(
            'article',
            { class: 'lens-missing-item', 'data-severity': item.severity, 'data-required-for': item.required_for },
            el('header', { class: 'lens-missing-item-head' },
              el('h4', { class: 'lens-missing-item-label' }, item.label),
              el('span', { class: 'lens-missing-item-tag' }, item.required_for)
            ),
            el('p', { class: 'lens-missing-item-fallback' }, item.current_fallback),
            el('p', { class: 'lens-missing-item-hint' }, item.implementation_hint)
          )
        );
      }
    }
  };
}
