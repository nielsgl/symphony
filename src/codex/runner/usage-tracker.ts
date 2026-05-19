import type { CodexUsageTotals, TokenTelemetrySnapshot } from '../types';

import { asRecord, readNumber, readString, type ProtocolMessage } from './common';

function usageSnapshotSignature(usage: CodexUsageTotals): string {
  return JSON.stringify({
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(typeof usage.cached_input_tokens === 'number' ? { cached_input_tokens: usage.cached_input_tokens } : {}),
    ...(typeof usage.reasoning_output_tokens === 'number' ? { reasoning_output_tokens: usage.reasoning_output_tokens } : {}),
    ...(typeof usage.model_context_window === 'number' ? { model_context_window: usage.model_context_window } : {})
  });
}

function parseTokenTotals(payload: Record<string, unknown> | null): CodexUsageTotals | null {
  if (!payload) {
    return null;
  }

  const input = readNumberLike(payload.input_tokens ?? payload.inputTokens);
  const output = readNumberLike(payload.output_tokens ?? payload.outputTokens);
  const total = readNumberLike(payload.total_tokens ?? payload.totalTokens);
  if (input !== null && output !== null && total !== null) {
    const cached = readNumberLike(payload.cached_input_tokens ?? payload.cachedInputTokens);
    const reasoning = readNumberLike(payload.reasoning_output_tokens ?? payload.reasoningOutputTokens);
    const contextWindow = readNumberLike(payload.model_context_window ?? payload.modelContextWindow);
    return {
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      ...(cached !== null ? { cached_input_tokens: cached } : {}),
      ...(reasoning !== null ? { reasoning_output_tokens: reasoning } : {}),
      ...(contextWindow !== null ? { model_context_window: contextWindow } : {})
    };
  }

  return null;
}

function readNumberLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function mergeTokenUsageMetadata(
  absolute: CodexUsageTotals,
  tokenUsageContainer: Record<string, unknown> | null
): CodexUsageTotals {
  if (!tokenUsageContainer) {
    return absolute;
  }

  if (typeof absolute.model_context_window === 'number') {
    return absolute;
  }

  const containerContextWindow = tokenUsageContainer.model_context_window ?? tokenUsageContainer.modelContextWindow;
  if (typeof containerContextWindow === 'number') {
    return {
      ...absolute,
      model_context_window: containerContextWindow
    };
  }

  return absolute;
}

function parseLastTokenUsage(params: Record<string, unknown>): CodexUsageTotals | null {
  const info = asRecord(params.info);
  const usage = asRecord(params.usage);
  const tokenUsage = asRecord(params.tokenUsage) ?? asRecord(params.token_usage);

  return (
    parseTokenTotals(asRecord(info?.last_token_usage) ?? asRecord(info?.lastTokenUsage)) ??
    parseTokenTotals(asRecord(info?.delta_token_usage) ?? asRecord(info?.deltaTokenUsage)) ??
    parseTokenTotals(asRecord(params.last_token_usage) ?? asRecord(params.lastTokenUsage)) ??
    parseTokenTotals(asRecord(params.delta_token_usage) ?? asRecord(params.deltaTokenUsage) ?? asRecord(params.delta)) ??
    parseTokenTotals(asRecord(usage?.last_token_usage) ?? asRecord(usage?.lastTokenUsage)) ??
    parseTokenTotals(asRecord(usage?.delta_token_usage) ?? asRecord(usage?.deltaTokenUsage) ?? asRecord(usage?.delta)) ??
    parseTokenTotals(asRecord(tokenUsage?.last) ?? asRecord(tokenUsage?.last_usage)) ??
    parseTokenTotals(asRecord(tokenUsage?.delta) ?? asRecord(tokenUsage?.delta_usage))
  );
}

function parseTerminalSummaryUsage(method: string, params: Record<string, unknown>): CodexUsageTotals | null {
  if (method !== 'turn/completed' && method !== 'turn.completed' && method !== 'turn/failed' && method !== 'turn.failed') {
    return null;
  }

  const usage = asRecord(params.usage);
  const summary = asRecord(params.summary);
  const info = asRecord(params.info);
  return (
    parseTokenTotals(usage) ??
    parseTokenTotals(asRecord(usage?.total_token_usage) ?? asRecord(usage?.totalTokenUsage)) ??
    parseTokenTotals(asRecord(summary?.usage)) ??
    parseTokenTotals(asRecord(summary?.total_token_usage) ?? asRecord(summary?.totalTokenUsage)) ??
    parseTokenTotals(asRecord(info?.total_token_usage) ?? asRecord(info?.totalTokenUsage)) ??
    parseTokenTotals(asRecord(params.total_token_usage) ?? asRecord(params.totalTokenUsage))
  );
}

function parsePersistedFallbackUsage(params: Record<string, unknown>): CodexUsageTotals | null {
  const usage = asRecord(params.usage);
  return (
    parseTokenTotals(asRecord(params.persisted_usage) ?? asRecord(params.persistedUsage)) ??
    parseTokenTotals(asRecord(params.persisted_fallback_usage) ?? asRecord(params.persistedFallbackUsage)) ??
    parseTokenTotals(asRecord(usage?.persisted_usage) ?? asRecord(usage?.persistedUsage)) ??
    parseTokenTotals(asRecord(usage?.persisted_fallback_usage) ?? asRecord(usage?.persistedFallbackUsage))
  );
}

interface UsageObservation {
  usage: CodexUsageTotals;
  source: string;
  // Canonical precedence: terminal turn summary > incremental turn usage > persisted fallback usage.
  precedence: 1 | 2 | 3;
  absolute: boolean;
}

export class UsageTracker {
  private lastAbsolute: CodexUsageTotals | null = null;
  private highestPrecedence: UsageObservation['precedence'] | null = null;
  private lastIncrementalSignature: string | null = null;
  private aggregate: CodexUsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0
  };
  private telemetry: TokenTelemetrySnapshot = {
    token_telemetry_status: 'unavailable',
    token_telemetry_last_source: null,
    token_telemetry_last_at_ms: null
  };

  observe(message: ProtocolMessage, observedAtMs: number = Date.now()): void {
    const observation = this.extractObservation(message);
    if (!observation) {
      return;
    }

    if (this.highestPrecedence !== null && observation.precedence > this.highestPrecedence) {
      return;
    }
    if (this.highestPrecedence !== null && observation.precedence < this.highestPrecedence) {
      this.aggregate = {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      };
      this.lastAbsolute = null;
      this.lastIncrementalSignature = null;
    }

    if (observation.precedence === 1) {
      this.aggregate = { ...observation.usage };
      this.lastAbsolute = { ...observation.usage };
      this.recordTelemetry(observation.source, observedAtMs);
      this.highestPrecedence = observation.precedence;
      this.lastIncrementalSignature = null;
      return;
    }

    if (observation.precedence === 3) {
      this.aggregate = { ...observation.usage };
      this.lastAbsolute = { ...observation.usage };
      this.recordTelemetry(observation.source, observedAtMs);
      this.highestPrecedence = observation.precedence;
      return;
    }

    const signature = JSON.stringify(observation.usage);
    if (!observation.absolute && signature === this.lastIncrementalSignature) {
      return;
    }

    if (observation.absolute) {
      if (!this.lastAbsolute) {
        this.aggregate = { ...observation.usage };
      } else {
        this.addAbsoluteDelta(observation.usage);
      }
      this.lastAbsolute = { ...observation.usage };
    } else {
      this.addIncrementalUsage(observation.usage);
      this.lastIncrementalSignature = signature;
    }

    this.recordTelemetry(observation.source, observedAtMs);
    this.highestPrecedence = observation.precedence;
  }

  private extractObservation(message: ProtocolMessage): UsageObservation | null {
    const method = (message.method ?? '').toLowerCase();
    const params = asRecord(message.params);
    if (!params) {
      return null;
    }

    const terminalSummary = parseTerminalSummaryUsage(method, params);
    if (terminalSummary) {
      return {
        usage: terminalSummary,
        source: 'terminal_turn_summary',
        precedence: 1,
        absolute: true
      };
    }

    let absolute: CodexUsageTotals | null = null;
    let source = 'incremental_usage';
    if (method === 'thread/tokenusage/updated') {
      const tokenUsage = asRecord(params.tokenUsage) ?? asRecord(params.token_usage);
      const parsedTotal = parseTokenTotals(asRecord(tokenUsage?.total));
      absolute = parsedTotal ? mergeTokenUsageMetadata(parsedTotal, tokenUsage) : null;
      source = 'thread/tokenUsage/updated.params.tokenUsage.total';
    }

    if (!absolute) {
      const info = asRecord(params.info);
      const infoTotalTokenUsage = asRecord(info?.total_token_usage) ?? asRecord(info?.totalTokenUsage);
      absolute = parseTokenTotals(infoTotalTokenUsage);
      source = 'params.info.total_token_usage';
    }

    if (!absolute) {
      const totalTokenUsage = asRecord(params.total_token_usage) ?? asRecord(params.totalTokenUsage);
      absolute = parseTokenTotals(totalTokenUsage);
      source = 'params.total_token_usage';
    }

    if (!absolute) {
      const usage = asRecord(params.usage);
      const usageTotalTokenUsage = asRecord(usage?.total_token_usage) ?? asRecord(usage?.totalTokenUsage);
      absolute = parseTokenTotals(usageTotalTokenUsage);
      source = 'params.usage.total_token_usage';
    }

    if (absolute) {
      return {
        usage: absolute,
        source,
        precedence: 2,
        absolute: true
      };
    }

    const lastUsage = parseLastTokenUsage(params);
    if (lastUsage) {
      return {
        usage: lastUsage,
        source: 'last_token_usage',
        precedence: 2,
        absolute: false
      };
    }

    const persistedUsage = parsePersistedFallbackUsage(params);
    if (persistedUsage) {
      return {
        usage: persistedUsage,
        source: 'persisted_fallback_usage',
        precedence: 3,
        absolute: true
      };
    }

    return null;
  }

  private addAbsoluteDelta(absolute: CodexUsageTotals): void {
    const previous = this.lastAbsolute;
    if (!previous) {
      this.aggregate = { ...absolute };
      return;
    }
    this.aggregate.input_tokens += Math.max(0, absolute.input_tokens - previous.input_tokens);
    this.aggregate.output_tokens += Math.max(0, absolute.output_tokens - previous.output_tokens);
    this.aggregate.total_tokens += Math.max(0, absolute.total_tokens - previous.total_tokens);
    if (typeof absolute.cached_input_tokens === 'number' && typeof previous.cached_input_tokens === 'number') {
      this.aggregate.cached_input_tokens = (this.aggregate.cached_input_tokens ?? 0) +
        Math.max(0, absolute.cached_input_tokens - previous.cached_input_tokens);
    } else if (typeof absolute.cached_input_tokens === 'number' && this.aggregate.cached_input_tokens === undefined) {
      this.aggregate.cached_input_tokens = absolute.cached_input_tokens;
    }

    if (
      typeof absolute.reasoning_output_tokens === 'number' &&
      typeof previous.reasoning_output_tokens === 'number'
    ) {
      this.aggregate.reasoning_output_tokens = (this.aggregate.reasoning_output_tokens ?? 0) +
        Math.max(0, absolute.reasoning_output_tokens - previous.reasoning_output_tokens);
    } else if (typeof absolute.reasoning_output_tokens === 'number' && this.aggregate.reasoning_output_tokens === undefined) {
      this.aggregate.reasoning_output_tokens = absolute.reasoning_output_tokens;
    }

    if (typeof absolute.model_context_window === 'number') {
      this.aggregate.model_context_window = absolute.model_context_window;
    }
  }

  private addIncrementalUsage(usage: CodexUsageTotals): void {
    this.aggregate.input_tokens += Math.max(0, usage.input_tokens);
    this.aggregate.output_tokens += Math.max(0, usage.output_tokens);
    this.aggregate.total_tokens += Math.max(0, usage.total_tokens);
    if (typeof usage.cached_input_tokens === 'number') {
      this.aggregate.cached_input_tokens = (this.aggregate.cached_input_tokens ?? 0) + Math.max(0, usage.cached_input_tokens);
    }
    if (typeof usage.reasoning_output_tokens === 'number') {
      this.aggregate.reasoning_output_tokens =
        (this.aggregate.reasoning_output_tokens ?? 0) + Math.max(0, usage.reasoning_output_tokens);
    }
    if (typeof usage.model_context_window === 'number') {
      this.aggregate.model_context_window = usage.model_context_window;
    }
  }

  private recordTelemetry(source: string, observedAtMs: number): void {
    this.telemetry = {
      token_telemetry_status: 'available',
      token_telemetry_last_source: source,
      token_telemetry_last_at_ms: observedAtMs
    };
  }

  snapshot(): CodexUsageTotals {
    return { ...this.aggregate };
  }

  telemetrySnapshot(): TokenTelemetrySnapshot {
    return { ...this.telemetry };
  }
}


export { usageSnapshotSignature };
