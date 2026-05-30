import { elements } from './dom';
import { renderConstellationCore } from './apple-constellation-core';
import { renderConstellationGravity } from './apple-constellation-gravity';
import { renderConstellationInterlocks } from './apple-constellation-interlocks';

export function renderAppleConstellation(payload: any) {
  if (!elements.constellationCore) {
    return;
  }

  const running = Array.isArray(payload && payload.running) ? payload.running : [];
  const blocked = Array.isArray(payload && payload.blocked) ? payload.blocked : [];
  const retry = Array.isArray(payload && payload.retry) ? payload.retry : [];
  const focus = running[0] || blocked[0] || retry[0] || null;

  renderConstellationGravity({ running, blocked, retry, focus });
  renderConstellationCore({ running, blocked, retry, focus });
  renderConstellationInterlocks({ running, blocked, retry, focus });
  elements.constellationWorkerCount.textContent =
    String(running.length) + ' / ' + String(running.length + blocked.length + retry.length);
  elements.constellationQueueCount.textContent = String(blocked.length + retry.length);
}
