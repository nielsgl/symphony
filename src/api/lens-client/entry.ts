import { startLens } from './app';

function boot() {
  const root = document.getElementById('lens-root');
  if (!root) {
    document.body.innerHTML = '<p class="lens-boot-error">Lens root element missing.</p>';
    return;
  }
  startLens(root as HTMLElement);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
