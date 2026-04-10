import type { TrackerErrorCode } from './types';

export class TrackerAdapterError extends Error {
  readonly code: TrackerErrorCode;

  constructor(code: TrackerErrorCode, message: string) {
    super(message);
    this.name = 'TrackerAdapterError';
    this.code = code;
  }
}
