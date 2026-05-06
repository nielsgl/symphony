export const DYNAMIC_TOOL_CAPABILITY_MISMATCH_DETAIL_TYPE = 'dynamic_tool_capability_mismatch';
export const UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE = 'unsupported_dynamic_tool_console_resume';
export const DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION =
  'Resume this Symphony-originated dynamic-tool session through the Symphony UI/API or another supported app-session path.';

export interface DynamicToolCapabilityMismatchDetail {
  diagnostic_type: typeof DYNAMIC_TOOL_CAPABILITY_MISMATCH_DETAIL_TYPE;
  reason_code: typeof UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE;
  source_environment: 'console_tui';
  attempted_tool_name: string | null;
  call_id: string | null;
  unsupported_capability_message: string;
  recommended_recovery_action: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function findUnsupportedMessage(value: unknown): string | null {
  const direct = readString(value);
  if (direct && /dynamic tool calls are not available in tui yet/i.test(direct)) {
    return direct;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const key of ['message', 'error', 'detail', 'reason', 'output']) {
    const nested = findUnsupportedMessage(record[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}

export function extractUnsupportedDynamicToolConsoleMessage(output: string): string | null {
  try {
    const parsed = findUnsupportedMessage(JSON.parse(output));
    if (parsed) {
      return parsed;
    }
  } catch {
    // Fall through to raw string matching.
  }

  return findUnsupportedMessage(output);
}

export function createDynamicToolCapabilityMismatchDetail(params: {
  attempted_tool_name: string | null;
  call_id: string | number | null | undefined;
  unsupported_capability_message: string;
}): DynamicToolCapabilityMismatchDetail {
  return {
    diagnostic_type: DYNAMIC_TOOL_CAPABILITY_MISMATCH_DETAIL_TYPE,
    reason_code: UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE,
    source_environment: 'console_tui',
    attempted_tool_name: params.attempted_tool_name,
    call_id: params.call_id === null || params.call_id === undefined ? null : String(params.call_id),
    unsupported_capability_message: params.unsupported_capability_message,
    recommended_recovery_action: DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION
  };
}

export function serializeDynamicToolCapabilityMismatchDetail(detail: DynamicToolCapabilityMismatchDetail): string {
  return JSON.stringify(detail);
}

export function parseDynamicToolCapabilityMismatchDetail(value: string | null | undefined): DynamicToolCapabilityMismatchDetail | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = asRecord(JSON.parse(value));
    if (parsed?.diagnostic_type !== DYNAMIC_TOOL_CAPABILITY_MISMATCH_DETAIL_TYPE) {
      return null;
    }
    if (parsed.reason_code !== UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE) {
      return null;
    }

    const message = readString(parsed.unsupported_capability_message);
    if (!message) {
      return null;
    }

    return {
      diagnostic_type: DYNAMIC_TOOL_CAPABILITY_MISMATCH_DETAIL_TYPE,
      reason_code: UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE,
      source_environment: 'console_tui',
      attempted_tool_name: readString(parsed.attempted_tool_name),
      call_id: readString(parsed.call_id),
      unsupported_capability_message: message,
      recommended_recovery_action:
        readString(parsed.recommended_recovery_action) ?? DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION
    };
  } catch {
    return null;
  }
}
