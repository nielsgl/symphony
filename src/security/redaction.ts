const REDACTED = '***REDACTED***';
const SECRET_KEY_PATTERN = /(token|secret|api[_-]?key|authorization|password)/i;
const INLINE_SECRET_PATTERN = /(token|secret|api[_-]?key|authorization|password)\s*[:=]\s*([^\s,;]+)/gi;

function redactStringValue(input: string): string {
  return input.replace(INLINE_SECRET_PATTERN, (_match, key) => `${key}=${REDACTED}`);
}

function redactByKey(key: string, value: unknown): unknown {
  if (!SECRET_KEY_PATTERN.test(key)) {
    return value;
  }

  if (value === null || value === undefined) {
    return value;
  }

  return REDACTED;
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactStringValue(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(record)) {
      const masked = redactByKey(key, raw);
      out[key] = masked === raw ? redactUnknown(raw) : masked;
    }
    return out;
  }

  return value;
}

export function redactLogInput(params: {
  message: string;
  context: Record<string, string | number | boolean | null>;
}): {
  message: string;
  context: Record<string, string | number | boolean | null>;
} {
  const redactedContext = redactUnknown(params.context) as Record<string, string | number | boolean | null>;
  return {
    message: redactStringValue(params.message),
    context: redactedContext
  };
}

export { REDACTED };
