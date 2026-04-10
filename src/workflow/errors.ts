import type { ValidationErrorCode, WorkflowErrorCode } from './types';

export class WorkflowConfigError extends Error {
  readonly code: WorkflowErrorCode | ValidationErrorCode;

  constructor(code: WorkflowErrorCode | ValidationErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowConfigError';
    this.code = code;
  }
}

export function nowIso(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}
