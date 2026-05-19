export function asIsoDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}
