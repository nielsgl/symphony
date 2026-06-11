// Top telemetry ribbon for the Living Agent Lens. The ribbon is mounted ONCE
// and mutated on each render — never torn down — so the breathing animations,
// audit dot, and refresh oscilloscope keep their phase across refreshes.

import { el, setText, setAttr } from './dom';
import { icon } from './icons';
import type { ShellTelemetry, TelemetryCell } from './types';

export interface ShellHandle {
  root: HTMLElement;
  update(shell: ShellTelemetry): void;
  /** Whether the Filters control is enabled (true means the backend supports it). */
  setFiltersEnabled(enabled: boolean, disabledReason: string | null): void;
}

export function mountShell(): ShellHandle {
  const refresh = mountCell('refresh_pulse');
  const orchestrator = mountCell('orchestrator');
  const runtime = mountCell('runtime_build');
  const health = mountCell('system_health');
  const audit = mountCell('audit');

  // Filters is disabled by default. The projector flips it on (via
  // setFiltersEnabled) only when the lens response indicates the smart-filter
  // surface is implemented.
  const filters = el('button', {
    type: 'button',
    class: 'lens-filters',
    'data-action': 'open-filters',
    'aria-disabled': 'true',
    'aria-label': 'Filters (smart-view filters not yet implemented)',
    title: 'Smart-view filters are not yet implemented.',
    disabled: true
  }, icon('filter'), el('span', { class: 'lens-filters-label' }, 'Filters'));

  const classicLink = el('a', {
    class: 'lens-classic-link',
    href: '/dashboard',
    rel: 'noopener',
    'aria-label': 'Open the classic Symphony operator dashboard'
  }, 'Classic Dashboard');

  const brandTitle = el('h1', { class: 'lens-brand-title' });
  const brandSubtitle = el('p', { class: 'lens-brand-subtitle' });
  const brandBlock = el('div', { class: 'lens-brand' }, brandTitle, brandSubtitle);

  const ribbon = el(
    'div',
    { class: 'lens-ribbon', role: 'region', 'aria-label': 'System telemetry ribbon' },
    refresh.root,
    orchestrator.root,
    runtime.root,
    health.root,
    audit.root,
    classicLink,
    filters
  );

  const root = el('header', { class: 'lens-shell-header' }, brandBlock, ribbon);

  return {
    root,
    update(shell) {
      setText(brandTitle, shell.brand.title);
      setText(brandSubtitle, shell.brand.subtitle);
      refresh.update(shell.refresh_pulse, 'pulse');
      orchestrator.update(shell.orchestrator, 'orbit');
      runtime.update(shell.runtime_build, 'hash');
      health.update(shell.system_health, 'shield-check');
      audit.update(shell.audit, 'record');
    },
    setFiltersEnabled(enabled, disabledReason) {
      if (enabled) {
        filters.removeAttribute('disabled');
        setAttr(filters, 'aria-disabled', 'false');
        setAttr(filters, 'aria-label', 'Open smart-view filters');
        setAttr(filters, 'title', '');
      } else {
        (filters as HTMLButtonElement).disabled = true;
        setAttr(filters, 'aria-disabled', 'true');
        const reason = disabledReason ?? 'Smart-view filters are not yet implemented.';
        setAttr(filters, 'aria-label', `Filters (${reason})`);
        setAttr(filters, 'title', reason);
      }
    }
  };
}

interface CellHandle {
  root: HTMLElement;
  update(cell: TelemetryCell, fallbackIcon: string): void;
}

function mountCell(id: string): CellHandle {
  const iconHost = el('span', { class: 'lens-cell-icon', 'aria-hidden': 'true' });
  const label = el('span', { class: 'lens-cell-label' });
  const value = el('span', { class: 'lens-cell-value' });
  const detail = el('span', { class: 'lens-cell-detail' });
  const root = el(
    'button',
    { type: 'button', class: 'lens-cell', 'data-cell': id, 'aria-label': id },
    iconHost,
    el('span', { class: 'lens-cell-text' }, label, value, detail)
  );

  return {
    root,
    update(cell, fallbackIcon) {
      iconHost.replaceChildren(icon(cell.icon || fallbackIcon, { size: 16 }));
      setText(label, cell.label);
      setText(value, cell.value);
      setText(detail, cell.detail ?? '');
      setAttr(root, 'data-tone', cell.tone);
      setAttr(root, 'data-endpoint', cell.detail_endpoint);
      // When there is no detail endpoint, the cell is read-only by design.
      // Disable the button + mark it visually so it doesn't imply an action.
      const interactive = Boolean(cell.detail_endpoint);
      (root as HTMLButtonElement).disabled = !interactive;
      setAttr(root, 'aria-disabled', interactive ? 'false' : 'true');
      const labelText = `${cell.label}: ${cell.value}${cell.detail ? ` — ${cell.detail}` : ''}`;
      setAttr(root, 'aria-label', interactive ? `${labelText} (click to open)` : `${labelText} (read-only)`);
      setAttr(root, 'title', interactive ? (cell.detail_endpoint ?? '') : '');
    }
  };
}
