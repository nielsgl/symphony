export class LocalApiError extends Error {
  readonly code: string;
  readonly http_status: number;

  constructor(code: string, message: string, http_status: number) {
    super(message);
    this.name = 'LocalApiError';
    this.code = code;
    this.http_status = http_status;
  }
}
