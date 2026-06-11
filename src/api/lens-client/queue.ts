// Notification Gravity queue — left column. Each row is a capsule with a state
// glyph, identifier, title, status, and gravity score. A connector dot on the
// right edge anchors the curve drawn by `connectors.ts`.

import { el, setAttr, setText } from './dom';
import { icon } from './icons';
import type { GravityIssue } from './types';

export interface QueueHandle {
  root: HTMLElement;
  update(rows: GravityIssue[], focusIdentifier: string | null): void;
  /** Returns the DOM node for the connector dot of a given identifier (used by connectors). */
  connectorDot(identifier: string): HTMLElement | null;
  onSelect(handler: (identifier: string) => void): void;
}

export function mountQueue(): QueueHandle {
  const list = el('ul', { class: 'lens-queue', role: 'listbox', 'aria-label': 'Notification gravity queue' });
  const empty = el('div', { class: 'lens-queue-empty hidden' }, 'No active work. Dispatch is idle.');
  const expand = el('button', { type: 'button', class: 'lens-queue-expand' }, 'Expand Constellation');

  const root = el(
    'section',
    { class: 'lens-queue-column', 'aria-labelledby': 'lens-queue-heading' },
    el(
      'header',
      { class: 'lens-column-head' },
      el('p', { class: 'lens-eyebrow' }, 'Notification Gravity'),
      el('h2', { id: 'lens-queue-heading', class: 'lens-column-title' }, 'Issues pulled toward focus')
    ),
    list,
    empty,
    expand
  );

  const rowsByIdentifier = new Map<string, RowHandle>();
  let selectHandlers: Array<(id: string) => void> = [];

  list.addEventListener('click', (event) => {
    const target = (event.target as Element | null)?.closest('[data-issue-row]') as HTMLElement | null;
    if (!target) return;
    const id = target.getAttribute('data-issue-row');
    if (!id) return;
    selectHandlers.forEach((h) => h(id));
  });

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = (event.target as Element | null)?.closest('[data-issue-row]') as HTMLElement | null;
    if (!target) return;
    event.preventDefault();
    const id = target.getAttribute('data-issue-row');
    if (id) selectHandlers.forEach((h) => h(id));
  });

  return {
    root,
    connectorDot(identifier) {
      return rowsByIdentifier.get(identifier)?.dot ?? null;
    },
    onSelect(handler) {
      selectHandlers.push(handler);
    },
    update(rows, focusIdentifier) {
      empty.classList.toggle('hidden', rows.length > 0);
      expand.classList.toggle('hidden', rows.length === 0);

      // Reconcile: keep existing rows by identifier, add/remove as needed.
      const seen = new Set<string>();
      let cursor: Element | null = list.firstElementChild;
      for (const row of rows) {
        seen.add(row.issue_identifier);
        let handle = rowsByIdentifier.get(row.issue_identifier);
        if (!handle) {
          handle = createRow();
          rowsByIdentifier.set(row.issue_identifier, handle);
        }
        if (handle.root !== cursor) {
          list.insertBefore(handle.root, cursor);
        }
        cursor = handle.root.nextElementSibling;
        handle.update(row, row.issue_identifier === focusIdentifier);
      }
      // Remove rows no longer present (they fade via CSS).
      for (const [id, handle] of rowsByIdentifier) {
        if (!seen.has(id)) {
          handle.root.classList.add('lens-queue-row-leaving');
          setTimeout(() => {
            if (handle.root.isConnected) handle.root.remove();
            rowsByIdentifier.delete(id);
          }, 320);
        }
      }
    }
  };
}

interface RowHandle {
  root: HTMLLIElement;
  dot: HTMLElement;
  update(row: GravityIssue, isFocus: boolean): void;
}

function createRow(): RowHandle {
  const glyphHost = el('span', { class: 'lens-row-glyph', 'aria-hidden': 'true' });
  const id = el('span', { class: 'lens-row-id' });
  const title = el('span', { class: 'lens-row-title' });
  const status = el('span', { class: 'lens-row-status' });
  const score = el('span', { class: 'lens-row-score' });
  const unit = el('span', { class: 'lens-row-unit' }, 'gravity');
  const dot = el('span', { class: 'lens-row-dot', 'aria-hidden': 'true' });
  const reasonsTooltip = el('span', { class: 'lens-row-tooltip', role: 'tooltip' });

  const body = el(
    'div',
    { class: 'lens-row-body' },
    el('div', { class: 'lens-row-head' }, id, status),
    title,
    el('div', { class: 'lens-row-meta' }, score, unit)
  );

  const root = el(
    'li',
    {
      class: 'lens-queue-row',
      role: 'option',
      tabindex: '0',
      'data-issue-row': ''
    },
    glyphHost,
    body,
    dot,
    reasonsTooltip
  ) as HTMLLIElement;

  return {
    root,
    dot,
    update(row, isFocus) {
      setAttr(root, 'data-issue-row', row.issue_identifier);
      setAttr(root, 'data-state', row.state);
      setAttr(root, 'data-band', row.gravity_band);
      setAttr(root, 'aria-selected', isFocus ? 'true' : 'false');
      root.classList.toggle('lens-queue-row-focus', isFocus);
      glyphHost.replaceChildren(icon(glyphName(row.glyph), { size: 18 }));
      setText(id, row.issue_identifier);
      setText(title, row.title);
      setText(status, row.status_label);
      setText(score, row.gravity_score.toFixed(2));
      // Build an honest tooltip from gravity reasons
      reasonsTooltip.replaceChildren(
        el('strong', {}, `Gravity ${row.gravity_score.toFixed(2)}`),
        ...row.gravity_reasons.map((reason) =>
          el('span', { class: 'lens-row-reason' }, `${reason.label} (+${reason.weight.toFixed(2)})`)
        )
      );
      setAttr(root, 'aria-label', `${row.issue_identifier} ${row.title} — ${row.status_label} — gravity ${row.gravity_score.toFixed(2)}${isFocus ? ' (focused)' : ''}`);
    }
  };
}

function glyphName(glyph: GravityIssue['glyph']): string {
  switch (glyph) {
    case 'focus': return 'star';
    case 'review': return 'square-stack';
    case 'running': return 'orbit';
    case 'blocked': return 'warning';
    case 'warning': return 'warning';
    case 'retry': return 'git-branch';
  }
}
