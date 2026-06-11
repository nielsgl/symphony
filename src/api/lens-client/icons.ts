// Minimal SVG icon set used by the lens. Returns an inline-stringified SVG
// path body so each component can embed icons without a build-time asset.

import { svg } from './dom';

const PATHS: Record<string, string> = {
  orbit:
    'M12 2v3M12 19v3M2 12h3M19 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  hash: 'M4 9h16M4 15h16M9 4v16M15 4v16',
  'shield-check': 'M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3zm-1 11l5-5-1.4-1.4L11 11.2 9.4 9.6 8 11l3 3z',
  record: 'M12 5a7 7 0 100 14 7 7 0 000-14z',
  pulse: 'M3 12h4l2-6 4 12 3-9 2 3h3',
  filter: 'M4 5h16l-6 8v6l-4-2v-4L4 5z',
  compass: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 4l3 7-7 3 4-10z',
  play: 'M6 4l14 8-14 8V4z',
  'document-search':
    'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h6m4-4l-2-2m1 0a3 3 0 100-6 3 3 0 000 6zM14 3v6h6',
  download: 'M12 3v12m-5-5l5 5 5-5M5 21h14',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  ellipsis: 'M5 12a2 2 0 114 0 2 2 0 01-4 0zm6 0a2 2 0 114 0 2 2 0 01-4 0zm6 0a2 2 0 114 0 2 2 0 01-4 0z',
  terminal: 'M4 4h16v16H4zm3 4l4 4-4 4m6 0h7',
  'git-branch': 'M6 3v18M6 9a3 3 0 100-6 3 3 0 000 6zm12 12a3 3 0 100-6 3 3 0 000 6zm0-6V9a3 3 0 00-3-3H10',
  'square-stack': 'M6 6h12v12H6zM4 4h12M8 20h12V8',
  cube: 'M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7M3 17l9-4 9 4',
  beaker: 'M9 3h6v5l5 11H4l5-11V3z',
  wrench: 'M14.7 6.3a4 4 0 11-5.4 5.4l-6 6 2.5 2.5 6-6a4 4 0 005.4-5.4l-2.5 2.5-2-2 2-2z',
  cpu: 'M6 4h12v16H6zM4 8h2M4 12h2M4 16h2M18 8h2M18 12h2M18 16h2M9 9h6v6H9z',
  plug: 'M9 7V3m6 4V3M5 11h14v3a5 5 0 01-10 0v0a4 4 0 01-4-3z',
  layers: 'M12 3l9 5-9 5-9-5 9-5zm0 8l9 5-9 5-9-5 9-5z',
  star: 'M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5L12 3z',
  warning: 'M12 3l10 18H2L12 3zm0 6v6m0 3v.01',
  copy: 'M9 3h9v9M6 6h12v15H6z'
};

export function icon(name: string, options: { size?: number; class?: string; title?: string } = {}): SVGElement {
  const size = options.size ?? 16;
  const path = PATHS[name] ?? PATHS.orbit;
  const node = svg(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.7',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: options.class ?? 'icon',
      role: 'img',
      'aria-hidden': 'true'
    },
    svg('path', { d: path })
  );
  if (options.title) {
    node.setAttribute('aria-hidden', 'false');
    const title = svg('title', {});
    title.textContent = options.title;
    node.insertBefore(title, node.firstChild);
  }
  return node;
}
