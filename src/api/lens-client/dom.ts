// Tiny DOM helpers shared by every lens component.
// Keep imports allocation-free: this module is loaded on every refresh.

export type ChildLike = Node | string | null | undefined | false | ChildLike[];

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  ...children: ChildLike[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.className = String(value);
    } else if (key === 'data') {
      // not used directly
    } else if (key.startsWith('on') && typeof value === 'string') {
      // ignore; events are attached via addEventListener
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

export function svg(tag: string, attrs: Record<string, string | number | null | undefined> = {}, ...children: ChildLike[]): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(parent: Element, children: ChildLike[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (typeof child === 'string') {
      parent.appendChild(document.createTextNode(child));
    } else {
      parent.appendChild(child);
    }
  }
}

export function clear(node: Element) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setText(node: Element, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

export function setAttr(node: Element, key: string, value: string | null) {
  if (value === null) {
    if (node.hasAttribute(key)) node.removeAttribute(key);
  } else if (node.getAttribute(key) !== value) {
    node.setAttribute(key, value);
  }
}

export function setClass(node: Element, cls: string, on: boolean) {
  node.classList.toggle(cls, on);
}

export function on<K extends keyof HTMLElementEventMap>(
  node: Element,
  type: K,
  handler: (this: HTMLElement, ev: HTMLElementEventMap[K]) => unknown
) {
  node.addEventListener(type, handler as EventListener);
}

/** Returns the first ancestor (inclusive) matching the selector, or null. */
export function closest<T extends Element>(node: Element | null, selector: string): T | null {
  if (!node) return null;
  return (node.closest(selector) as T | null) ?? null;
}
