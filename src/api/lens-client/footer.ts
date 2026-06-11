// Status Footer — quiet single strip. Each cell has fixed width to satisfy the
// "no layout shift on refresh" rule.

import { el, setAttr, setText } from './dom';
import { icon } from './icons';
import type { FooterTelemetry, TelemetryCell } from './types';

export interface FooterHandle {
  root: HTMLElement;
  update(footer: FooterTelemetry): void;
}

export function mountFooter(): FooterHandle {
  const operator = mountText('Operator', '—');
  const snapshot = mountText('Runtime Time', '—:—:—');
  const local = mountText('Local Time', '—');
  const api = mountIconCell('plug');
  const workers = mountIconCell('cpu');
  const queues = mountIconCell('layers');

  const root = el(
    'footer',
    { class: 'lens-footer', 'aria-label': 'Status footer' },
    operator.root,
    snapshot.root,
    local.root,
    api.root,
    workers.root,
    queues.root
  );

  return {
    root,
    update(footer) {
      operator.setValue(footer.operator ?? 'unknown');
      snapshot.setValue(footer.snapshot_time);
      local.setValue(footer.local_time);
      api.update(footer.api, 'plug');
      workers.update(footer.workers, 'cpu');
      queues.update(footer.queues, 'layers');
    }
  };
}

interface TextCell {
  root: HTMLElement;
  setValue(value: string): void;
}

function mountText(label: string, initial: string): TextCell {
  const value = el('span', { class: 'lens-footer-value' }, initial);
  const root = el(
    'div',
    { class: 'lens-footer-cell' },
    el('span', { class: 'lens-footer-label' }, label),
    value
  );
  return {
    root,
    setValue(v) { setText(value, v); }
  };
}

interface IconCell {
  root: HTMLElement;
  update(cell: TelemetryCell, fallbackIcon: string): void;
}

function mountIconCell(initialIcon: string): IconCell {
  const iconHost = el('span', { class: 'lens-footer-icon', 'aria-hidden': 'true' }, icon(initialIcon, { size: 14 }));
  const label = el('span', { class: 'lens-footer-label' });
  const value = el('span', { class: 'lens-footer-value' });
  const root = el(
    'button',
    { type: 'button', class: 'lens-footer-cell lens-footer-cell-button', 'aria-label': label.textContent ?? '' },
    iconHost,
    el('span', { class: 'lens-footer-text' }, label, value)
  );
  return {
    root,
    update(cell, fallback) {
      iconHost.replaceChildren(icon(cell.icon || fallback, { size: 14 }));
      setText(label, cell.label);
      setText(value, cell.value);
      setAttr(root, 'data-tone', cell.tone);
      setAttr(root, 'aria-label', `${cell.label}: ${cell.value}${cell.detail ? ` — ${cell.detail}` : ''}`);
    }
  };
}
