import { elements } from './dom';

export function renderAppleConstellation(payload: any) {
  if (!elements.constellationCore) {
    return;
  }

  const running = Array.isArray(payload && payload.running) ? payload.running : [];
  const blocked = Array.isArray(payload && payload.blocked) ? payload.blocked : [];
  const retry = Array.isArray(payload && payload.retry) ? payload.retry : [];
  const focus = running[0] || blocked[0] || retry[0] || null;

  elements.constellationCore.textContent = focus
    ? (focus.issue_identifier || 'Focused issue') + ' is ready for constellation rendering.'
    : 'No active run is ready for constellation rendering.';
  elements.constellationIssueList.textContent = running
    .concat(blocked, retry)
    .slice(0, 6)
    .map(function (entry: any) {
      return entry.issue_identifier || 'unknown';
    })
    .join(' ');
  elements.constellationInterlockList.textContent = 'Preconditions, safe intervention, endpoint preview, and audit receipt.';
  elements.constellationEvidencePath.textContent = 'Thread -> transcript -> API snapshot -> audit receipt.';
  elements.constellationActions.textContent = 'Steer Resume Inspect Evidence Export Forensics Drain Wait More';
  elements.constellationWorkerCount.textContent =
    String(running.length) + ' / ' + String(running.length + blocked.length + retry.length);
  elements.constellationQueueCount.textContent = String(blocked.length + retry.length);
}
