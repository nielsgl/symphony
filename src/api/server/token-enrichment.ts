import { REASON_CODES } from '../../observability';
import type { ApiDiagnosticsResponse, ApiIssueResponse, ApiStateResponse } from '../types';

export const LIVE_TOKEN_FALLBACK_CACHE_TTL_MS = 1_000;
export const LIVE_TOKEN_FALLBACK_MAX_THREAD_IDS = 25;

export interface LiveTokenFallbackCacheEntry {
  totalTokens: number | null;
  observedAtMs: number;
}

export function resolveLiveThreadTokenTotals(codexStateDbPath: string, threadIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (threadIds.length === 0) {
    return result;
  }

  let db:
    | {
        prepare: (sql: string) => {
          get: (...params: unknown[]) => { tokens_used?: number } | undefined;
        };
        close: () => void;
      }
    | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (path: string, options?: { readonly?: boolean }) => {
        prepare: (sql: string) => {
          get: (...params: unknown[]) => { tokens_used?: number } | undefined;
        };
        close: () => void;
      };
    };
    db = new sqlite.DatabaseSync(codexStateDbPath, { readonly: true });
    const statement = db.prepare('SELECT tokens_used FROM threads WHERE id = ?');
    for (const threadId of threadIds) {
      const row = statement.get(threadId);
      if (row && typeof row.tokens_used === 'number' && row.tokens_used > 0) {
        result.set(threadId, row.tokens_used);
      }
    }
  } catch {
    return result;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures; fallback enrichment must not affect state projection.
    }
  }

  return result;
}

export function resolveCachedLiveThreadTokenTotals(options: {
  threadIds: string[];
  cache: Map<string, LiveTokenFallbackCacheEntry>;
  nowMs: () => number;
  codexStateDbPath: string;
}): Map<string, number> {
  const uniqueThreadIds = Array.from(
    new Set(options.threadIds.filter((threadId) => typeof threadId === 'string' && threadId.length > 0))
  ).slice(0, LIVE_TOKEN_FALLBACK_MAX_THREAD_IDS);
  const result = new Map<string, number>();
  if (uniqueThreadIds.length === 0) {
    return result;
  }

  const nowMs = options.nowMs();
  const staleThreadIds = uniqueThreadIds.filter((threadId) => {
    const cached = options.cache.get(threadId);
    return !cached || nowMs - cached.observedAtMs >= LIVE_TOKEN_FALLBACK_CACHE_TTL_MS;
  });

  if (staleThreadIds.length > 0) {
    const refreshedTotals = resolveLiveThreadTokenTotals(options.codexStateDbPath, staleThreadIds);
    for (const threadId of staleThreadIds) {
      options.cache.set(threadId, {
        totalTokens: refreshedTotals.get(threadId) ?? null,
        observedAtMs: nowMs
      });
    }
  }

  for (const threadId of uniqueThreadIds) {
    const cached = options.cache.get(threadId);
    if (cached && typeof cached.totalTokens === 'number' && cached.totalTokens > 0) {
      result.set(threadId, cached.totalTokens);
    }
  }
  return result;
}

export function enrichLiveTokenFallbackState(options: {
  payload: ApiStateResponse;
  cache: Map<string, LiveTokenFallbackCacheEntry>;
  nowMs: () => number;
  codexStateDbPath: string;
}): ApiDiagnosticsResponse['token_enrichment'] {
  const { payload } = options;
  if (payload.running.length === 0) {
    return {
      status: 'not_required',
      degraded: false,
      reason_code: null,
      duration_ms: 0
    };
  }
  const threadIds = payload.running
    .map((row) => row.thread_id)
    .filter((threadId): threadId is string => typeof threadId === 'string' && threadId.length > 0);
  const needsLiveTokenFallback = payload.running.some(
    (row) => row.tokens.total_tokens === 0 && row.thread_id && row.token_telemetry_status !== 'available'
  );
  if (!needsLiveTokenFallback) {
    return {
      status: 'not_required',
      degraded: false,
      reason_code: null,
      duration_ms: 0
    };
  }

  const liveTotals = resolveCachedLiveThreadTokenTotals({
    threadIds,
    cache: options.cache,
    nowMs: options.nowMs,
    codexStateDbPath: options.codexStateDbPath
  });
  let liveAggregate = 0;
  for (const row of payload.running) {
    if (row.tokens.total_tokens > 0 || !row.thread_id) {
      continue;
    }
    const liveTotal = liveTotals.get(row.thread_id);
    if (typeof liveTotal === 'number' && liveTotal > 0) {
      row.tokens.total_tokens = liveTotal;
      row.token_telemetry_status = 'available';
      row.token_telemetry_last_source = 'codex_home_state_sqlite';
      row.token_telemetry_last_at_ms = options.nowMs();
      row.token_telemetry_confidence = 'backfilled';
      row.token_telemetry_source = 'codex_home_state_sqlite';
      row.token_telemetry_last_observed_at_ms = row.token_telemetry_last_at_ms;
      row.tokens.token_split_status = 'aggregate_only';
      liveAggregate += liveTotal;
    }
  }

  if (liveAggregate > 0) {
    payload.codex_totals.total_tokens += liveAggregate;
    payload.codex_totals.token_split_status = 'aggregate_only';
  }

  if (liveAggregate > 0) {
    return {
      status: 'available',
      degraded: false,
      reason_code: null,
      duration_ms: 0
    };
  }

  return {
    status: 'degraded',
    degraded: true,
    reason_code: REASON_CODES.liveTokenFallbackNotOnHotPath,
    duration_ms: 0
  };
}

export function enrichLiveTokenFallbackIssue(options: {
  payload: ApiIssueResponse;
  nowMs: () => number;
  codexStateDbPath: string;
}): void {
  const { payload } = options;
  if (payload.status !== 'running' || !payload.running?.thread_id) {
    return;
  }
  if (payload.running.tokens.total_tokens > 0) {
    return;
  }
  const threadId = payload.running.thread_id;
  const liveTotal = resolveLiveThreadTokenTotals(options.codexStateDbPath, [threadId]).get(threadId);
  if (typeof liveTotal === 'number' && liveTotal > 0) {
    payload.running.tokens.total_tokens = liveTotal;
    payload.running.token_telemetry_status = 'available';
    payload.running.token_telemetry_last_source = 'codex_home_state_sqlite';
    payload.running.token_telemetry_last_at_ms = options.nowMs();
    payload.running.token_telemetry_confidence = 'backfilled';
    payload.running.token_telemetry_source = 'codex_home_state_sqlite';
    payload.running.token_telemetry_last_observed_at_ms = payload.running.token_telemetry_last_at_ms;
    payload.running.tokens.token_split_status = 'aggregate_only';
  }
}

export function summarizeTokenTelemetry(payload: ApiStateResponse): Pick<
  ApiDiagnosticsResponse,
  'token_telemetry_status' | 'token_telemetry_last_source' | 'token_telemetry_last_at_ms'
> {
  const rank = {
    unavailable: 0,
    pending: 1,
    available: 2
  } as const;
  let selected: ApiStateResponse['running'][number] | null = null;
  for (const row of payload.running) {
    if (!selected) {
      selected = row;
      continue;
    }
    const rowRank = rank[row.token_telemetry_status];
    const selectedRank = rank[selected.token_telemetry_status];
    const rowAt = row.token_telemetry_last_at_ms ?? Number.NEGATIVE_INFINITY;
    const selectedAt = selected.token_telemetry_last_at_ms ?? Number.NEGATIVE_INFINITY;
    if (rowRank > selectedRank || (rowRank === selectedRank && rowAt > selectedAt)) {
      selected = row;
    }
  }

  return {
    token_telemetry_status: selected?.token_telemetry_status ?? 'unavailable',
    token_telemetry_last_source: selected?.token_telemetry_last_source ?? null,
    token_telemetry_last_at_ms: selected?.token_telemetry_last_at_ms ?? null
  };
}
