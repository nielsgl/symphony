const REDACTED = '***REDACTED***';
const SECRET_KEY_PATTERN =
  /^(authorization|proxy-authorization|x-api-key|api[_-]?key|secret|password|passphrase|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|token)$/i;
const AUTHORIZATION_HEADER_PATTERN = /\b((?:proxy-)?authorization)\s*[:=]\s*[A-Z][A-Z0-9_-]*\s+[^\s,;]+/gi;
const AUTHORIZATION_SCHEME_PATTERN = /\b(bearer|basic)\s+[^\s,;]+/gi;
const INLINE_SECRET_PATTERN = /(token|secret|api[_-]?key|authorization|password)\s*[:=]\s*([^\s,;]+)/gi;
const BARE_SECRET_PATTERN =
  /\b(?:sk|rk|ghp|github_pat|glpat|xox[baprs]?|ya29|AKIA)[A-Za-z0-9_-]{8,}\b/g;
const ACCOUNT_IDENTIFIER_ASSIGNMENT_PATTERN =
  /\b(account[_-]?id|acct|org[_-]?id|organization[_-]?id)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9_.:-]{5,})/gi;

function redactStringValue(input: string): string {
  return input
    .replace(AUTHORIZATION_HEADER_PATTERN, (_match, key) => `${key}=${REDACTED}`)
    .replace(INLINE_SECRET_PATTERN, (_match, key) => `${key}=${REDACTED}`)
    .replace(AUTHORIZATION_SCHEME_PATTERN, (_match, scheme) => `${scheme} ${REDACTED}`)
    .replace(ACCOUNT_IDENTIFIER_ASSIGNMENT_PATTERN, (_match, key) => `${key}=${REDACTED}`)
    .replace(BARE_SECRET_PATTERN, REDACTED);
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
