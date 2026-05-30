import { elements } from './dom';

export function renderConstellationGravity(model: any) {
  const entries = []
    .concat(model.running || [], model.blocked || [], model.retry || [])
    .slice(0, 6);

  elements.constellationIssueList.textContent = entries
    .map(function (entry: any) {
      return entry.issue_identifier || 'unknown';
    })
    .join(' ');
}
