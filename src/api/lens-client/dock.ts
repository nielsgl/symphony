// Action Dock — six capsules (Steer, Resume, Inspect Evidence, Export
// Forensics, Drain: Wait, More). Fixed-size states across idle/loading/success/
// error to satisfy "no layout shift" rule.

import { el, setAttr, setText, clear } from './dom';
import { icon } from './icons';
import type { ActionButton } from './types';

export interface DockHandle {
  root: HTMLElement;
  update(buttons: ActionButton[]): void;
  onActivate(handler: (id: ActionButton['id']) => void): void;
  onMoreItem(handler: (itemId: string, endpoint: string | null) => void): void;
}

export function mountDock(): DockHandle {
  const row = el('div', { class: 'lens-dock-row', role: 'toolbar', 'aria-label': 'Operator actions' });
  const handles = new Map<ActionButton['id'], ActionHandle>();
  const order: Array<ActionButton['id']> = ['steer', 'resume', 'inspect_evidence', 'export_forensics', 'drain_wait', 'more'];
  for (const id of order) {
    const handle = createButton(id);
    handles.set(id, handle);
    row.appendChild(handle.root);
  }

  const root = el(
    'section',
    { class: 'lens-dock', 'aria-label': 'Action dock' },
    row
  );

  const activateHandlers: Array<(id: ActionButton['id']) => void> = [];
  const moreHandlers: Array<(itemId: string, endpoint: string | null) => void> = [];

  row.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const itemNode = target.closest('[data-more-item]') as HTMLElement | null;
    if (itemNode) {
      const id = itemNode.getAttribute('data-more-item') ?? '';
      const endpoint = itemNode.getAttribute('data-endpoint');
      moreHandlers.forEach((h) => h(id, endpoint));
      return;
    }
    const btn = target.closest('[data-action-id]') as HTMLElement | null;
    if (!btn) return;
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const id = btn.getAttribute('data-action-id') as ActionButton['id'] | null;
    if (id === 'more') {
      const handle = handles.get('more');
      handle?.toggleMenu();
      return;
    }
    if (id) activateHandlers.forEach((h) => h(id));
  });

  return {
    root,
    onActivate(handler) { activateHandlers.push(handler); },
    onMoreItem(handler) { moreHandlers.push(handler); },
    update(buttons) {
      for (const button of buttons) {
        const handle = handles.get(button.id);
        if (handle) handle.update(button);
      }
    }
  };
}

interface ActionHandle {
  root: HTMLElement;
  update(button: ActionButton): void;
  toggleMenu(): void;
}

function createButton(id: ActionButton['id']): ActionHandle {
  const iconHost = el('span', { class: 'lens-dock-icon', 'aria-hidden': 'true' });
  const label = el('span', { class: 'lens-dock-label' });
  const intent = el('span', { class: 'lens-dock-intent' });
  const root = el(
    'button',
    {
      type: 'button',
      class: 'lens-dock-button',
      'data-action-id': id,
      'aria-haspopup': id === 'more' ? 'menu' : 'false'
    },
    iconHost,
    el('span', { class: 'lens-dock-text' }, label, intent)
  );

  const menu = el('div', { class: 'lens-dock-menu hidden', role: 'menu' });
  if (id === 'more') {
    root.appendChild(menu);
  }

  function closeMenu() {
    menu.classList.add('hidden');
    setAttr(root, 'aria-expanded', 'false');
  }

  if (id === 'more') {
    document.addEventListener('click', (event) => {
      if (!root.contains(event.target as Node)) closeMenu();
    });
  }

  return {
    root,
    toggleMenu() {
      if (id !== 'more') return;
      const isOpen = !menu.classList.contains('hidden');
      menu.classList.toggle('hidden', isOpen);
      setAttr(root, 'aria-expanded', isOpen ? 'false' : 'true');
    },
    update(button) {
      iconHost.replaceChildren(icon(button.icon || 'orbit', { size: 16 }));
      setText(label, button.label);
      setText(intent, button.intent_line);
      setAttr(root, 'data-tone', button.tone);
      setAttr(root, 'aria-disabled', button.enabled ? 'false' : 'true');
      setAttr(root, 'title', button.disabled_reason ?? '');
      setAttr(root, 'aria-label', `${button.label}${button.intent_line ? ` — ${button.intent_line}` : ''}${button.disabled_reason ? ` (disabled: ${button.disabled_reason})` : ''}`);
      if (id === 'more' && button.more_items) {
        clear(menu);
        for (const item of button.more_items) {
          const itemNode = el(
            'button',
            {
              type: 'button',
              class: 'lens-dock-menu-item',
              role: 'menuitem',
              'data-more-item': item.id,
              'data-endpoint': item.endpoint ?? '',
              'aria-disabled': item.enabled ? 'false' : 'true',
              title: item.disabled_reason ?? ''
            },
            item.label
          );
          menu.appendChild(itemNode);
        }
      }
    }
  };
}
