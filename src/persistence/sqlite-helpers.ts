export function sqlPlaceholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}
