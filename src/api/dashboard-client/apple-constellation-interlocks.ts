import { elements } from './dom';

export function renderConstellationInterlocks(_model: any) {
  elements.constellationInterlockList.textContent = 'Preconditions, safe intervention, endpoint preview, and audit receipt.';
  elements.constellationEvidencePath.textContent = 'Thread -> transcript -> API snapshot -> audit receipt.';
  elements.constellationActions.textContent = 'Steer Resume Inspect Evidence Export Forensics Drain Wait More';
}
