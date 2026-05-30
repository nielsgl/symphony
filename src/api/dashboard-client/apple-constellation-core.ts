import { elements } from './dom';

export function renderConstellationCore(model: any) {
  const focus = model.focus || null;
  elements.constellationCore.textContent = focus
    ? (focus.issue_identifier || 'Focused issue') + ' is ready for constellation rendering.'
    : 'No active run is ready for constellation rendering.';
}
