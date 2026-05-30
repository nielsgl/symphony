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
  const active = ([] as any[]).concat(running, blocked, retry);
  const focus =
    active.find((entry) => {
      const identifier = String(entry?.issue_identifier || entry?.identifier || entry?.issue_id || '').trim();
      return identifier === 'NIE-300';
    }) ||
    running[0] ||
    blocked[0] ||
    retry[0] ||
    null;

  renderConstellationGravity({ running, blocked, retry, focus });
  renderConstellationCore({ running, blocked, retry, focus });
  renderConstellationInterlocks({ running, blocked, retry, focus });
  elements.constellationWorkerCount.textContent =
    String(running.length) + ' / ' + String(running.length + blocked.length + retry.length);
  elements.constellationQueueCount.textContent = String(blocked.length + retry.length);
}
