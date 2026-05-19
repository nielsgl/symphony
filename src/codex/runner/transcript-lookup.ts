import fs from 'node:fs';
import path from 'node:path';

import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import type { CodexRunnerEvent, CodexTranscriptLookupMetadata } from '../types';

import { asRecord, normalizeEpochMs, normalizeTimestampMs, parseJsonRecord, readNumber, readString } from './common';

export interface TurnEventContext {
  thread_id: string;
  turn_id: string;
  session_id: string;
  turn_started_at_ms: number;
}

interface TranscriptTerminalEvidence {
  terminal: 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required';
  last_agent_message?: string;
  completed_at_ms?: number;
  duration_ms?: number;
  time_to_first_token_ms?: number;
}

interface TranscriptScanResult {
  terminal: TranscriptTerminalEvidence | null;
  observedProgress: boolean;
  lookup: TranscriptCandidateLookupResult | null;
}

interface TranscriptCandidateCache {
  identityKey: string;
  refreshedAtMs: number;
  paths: string[];
  stats: TranscriptCandidateLookupStats;
  scannedDirectoryMtimes?: Array<{ directory: string; mtimeMs: number }>;
}

interface TranscriptCandidateLookupStats {
  source: 'indexed' | 'filename' | 'fallback' | 'cache' | 'missing' | 'budget_exhausted';
  cachedSource?: 'indexed' | 'filename' | 'fallback' | 'missing' | 'budget_exhausted';
  candidateCount: number;
  filesConsidered: number;
  filesParsed: number;
  bytesRead: number;
  exhausted: boolean;
  reasonCodes: string[];
}

interface TranscriptCandidateLookupResult {
  paths: string[];
  stats: TranscriptCandidateLookupStats;
  refreshedAtMs: number;
  expiresAtMs: number;
}

export function serializeTranscriptLookupMetadata(lookup: TranscriptCandidateLookupResult): CodexTranscriptLookupMetadata {
  return {
    source: lookup.stats.source,
    ...(lookup.stats.cachedSource ? { cached_source: lookup.stats.cachedSource } : {}),
    candidate_count: lookup.stats.candidateCount,
    files_considered: lookup.stats.filesConsidered,
    files_parsed: lookup.stats.filesParsed,
    bytes_read: lookup.stats.bytesRead,
    exhausted: lookup.stats.exhausted,
    reason_codes: [...lookup.stats.reasonCodes],
    cache_refreshed_at_ms: lookup.refreshedAtMs,
    cache_expires_at_ms: lookup.expiresAtMs
  };
}

function parseCodexRolloutTimestampMs(filename: string): number | null {
  const match = filename.match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:[.-](\d{3}))?/);
  if (!match) {
    return null;
  }
  const [, date, hour, minute, second, millis = '000'] = match;
  const parsed = Date.parse(`${date}T${hour}:${minute}:${second}.${millis}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCodexSessionsDirectoryRangeMs(directoryPath: string, sessionsRoot: string): { startMs: number; endMs: number } | null {
  const relativePath = path.relative(sessionsRoot, directoryPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  const [yearText, monthText, dayText] = relativePath.split(path.sep);
  if (!/^\d{4}$/.test(yearText ?? '')) {
    return null;
  }
  const year = Number(yearText);
  if (monthText === undefined) {
    return { startMs: Date.UTC(year, 0, 1), endMs: Date.UTC(year + 1, 0, 1) };
  }
  if (!/^\d{2}$/.test(monthText)) {
    return null;
  }
  const monthIndex = Number(monthText) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  if (dayText === undefined) {
    return {
      startMs: Date.UTC(year, monthIndex, 1),
      endMs: Date.UTC(year, monthIndex + 1, 1)
    };
  }
  if (!/^\d{2}$/.test(dayText)) {
    return null;
  }
  const day = Number(dayText);
  const startMs = Date.UTC(year, monthIndex, day);
  const startDate = new Date(startMs);
  if (startDate.getUTCFullYear() !== year || startDate.getUTCMonth() !== monthIndex || startDate.getUTCDate() !== day) {
    return null;
  }
  return { startMs, endMs: Date.UTC(year, monthIndex, day + 1) };
}

function distanceToTimeRangeMs(activeStartedAtMs: number, range: { startMs: number; endMs: number }): number {
  if (activeStartedAtMs < range.startMs) {
    return range.startMs - activeStartedAtMs;
  }
  if (activeStartedAtMs >= range.endMs) {
    return activeStartedAtMs - range.endMs;
  }
  return 0;
}

export class TranscriptLookup {
  private readonly codexHome: string;
  private readonly transcriptOffsets = new Map<string, number>();
  private readonly transcriptTails = new Map<string, string>();
  private transcriptCandidateCache: TranscriptCandidateCache | null = null;
  private lastTranscriptLookupDiagnosticKey: string | null = null;

  private static readonly TRANSCRIPT_CANDIDATE_CACHE_TTL_MS = 15_000;
  private static readonly TRANSCRIPT_MAX_CANDIDATE_FILES = 40;
  private static readonly TRANSCRIPT_MAX_FILENAME_DISCOVERY_FILES = 1000;
  private static readonly TRANSCRIPT_MAX_DISCOVERY_FILES = 20;
  private static readonly TRANSCRIPT_MAX_PROBE_BYTES = 256 * 1024;
  private static readonly TRANSCRIPT_MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly TRANSCRIPT_MAX_WALL_CLOCK_MS = 50;
  private static readonly TRANSCRIPT_MAX_DEPTH = 5;

  constructor(codexHome: string) {
    this.codexHome = codexHome;
  }

  consumeTerminalEvidence(
    context: TurnEventContext,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void,
    onRecord: (payload: Record<string, unknown>, observedAtMs: number) => void
  ): TranscriptScanResult {
    let observedProgress = false;

    const lookup = this.findCandidateTranscriptPaths(context);
    this.emitTranscriptLookupDiagnostic(lookup, context, emit);

    for (const transcriptPath of lookup.paths) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }

      const storedOffset = this.transcriptOffsets.get(transcriptPath) ?? 0;
      const previousOffset = Math.min(storedOffset, stat.size);
      if (stat.size < storedOffset) {
        this.transcriptTails.delete(transcriptPath);
      }
      if (stat.size <= previousOffset) {
        continue;
      }
      observedProgress = true;

      let content = '';
      try {
        const fd = fs.openSync(transcriptPath, 'r');
        try {
          const buffer = Buffer.alloc(stat.size - previousOffset);
          fs.readSync(fd, buffer, 0, buffer.length, previousOffset);
          content = buffer.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      const previousTail = this.transcriptTails.get(transcriptPath) ?? '';
      const combined = previousTail + content;
      const endsWithNewline = combined.endsWith('\n');
      const rawLines = combined.split('\n');
      const completeLines = rawLines.slice(0, -1);
      const nextTail = endsWithNewline ? '' : (rawLines.at(-1) ?? '');
      this.transcriptOffsets.set(transcriptPath, stat.size);
      if (nextTail) {
        this.transcriptTails.set(transcriptPath, nextTail);
      } else {
        this.transcriptTails.delete(transcriptPath);
      }

      for (const line of completeLines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const record = parseJsonRecord(trimmed);
        if (!record) {
          continue;
        }

        const payload = asRecord(record.payload) ?? record;
        onRecord(payload, normalizeTimestampMs(record.timestamp) ?? Date.now());
        const terminalEvidence = this.readTranscriptTerminalEvidence(record, transcriptPath, context, emit);
        if (terminalEvidence) {
          return { terminal: terminalEvidence, observedProgress, lookup };
        }
      }
    }

    return { terminal: null, observedProgress, lookup };
  }

  private findCandidateTranscriptPaths(context: TurnEventContext): TranscriptCandidateLookupResult {
    const identityKey = this.transcriptCandidateIdentityKey(context);
    const nowMs = Date.now();
    if (
      this.transcriptCandidateCache &&
      this.transcriptCandidateCache.identityKey === identityKey &&
      nowMs - this.transcriptCandidateCache.refreshedAtMs < TranscriptLookup.TRANSCRIPT_CANDIDATE_CACHE_TTL_MS &&
      this.isTranscriptCandidateCacheFresh()
    ) {
      const cachedStats = this.transcriptCandidateCache.stats;
      return {
        paths: [...this.transcriptCandidateCache.paths],
        stats: {
          ...cachedStats,
          source: 'cache',
          cachedSource: cachedStats.source === 'cache' ? cachedStats.cachedSource : cachedStats.source,
          reasonCodes: [...cachedStats.reasonCodes]
        },
        refreshedAtMs: this.transcriptCandidateCache.refreshedAtMs,
        expiresAtMs: this.transcriptCandidateCache.refreshedAtMs + TranscriptLookup.TRANSCRIPT_CANDIDATE_CACHE_TTL_MS
      };
    }

    const indexedPaths = [...this.transcriptOffsets.keys()].filter((transcriptPath) =>
      this.transcriptPathMayMatch(transcriptPath, context)
    );
    if (indexedPaths.length > 0) {
      const limitedPaths = indexedPaths.slice(0, TranscriptLookup.TRANSCRIPT_MAX_CANDIDATE_FILES);
      const stats: TranscriptCandidateLookupStats = {
        source: 'indexed',
        candidateCount: limitedPaths.length,
        filesConsidered: indexedPaths.length,
        filesParsed: 0,
        bytesRead: 0,
        exhausted: indexedPaths.length > limitedPaths.length,
        reasonCodes: indexedPaths.length > limitedPaths.length ? ['transcript_candidate_file_budget_exhausted'] : []
      };
      return this.cacheTranscriptLookup(identityKey, nowMs, limitedPaths, stats);
    }

    const sessionsRoot = path.join(this.codexHome, 'sessions');
    let rootStat: fs.Stats;
    try {
      rootStat = fs.statSync(sessionsRoot);
    } catch {
      return this.cacheTranscriptLookup(identityKey, nowMs, [], {
        source: 'missing',
        candidateCount: 0,
        filesConsidered: 0,
        filesParsed: 0,
        bytesRead: 0,
        exhausted: false,
        reasonCodes: ['transcript_sessions_root_missing']
      });
    }
    if (!rootStat.isDirectory()) {
      return this.cacheTranscriptLookup(identityKey, nowMs, [], {
        source: 'missing',
        candidateCount: 0,
        filesConsidered: 0,
        filesParsed: 0,
        bytesRead: 0,
        exhausted: false,
        reasonCodes: ['transcript_sessions_root_missing']
      });
    }

    const filenameLookup = this.findFilenameMatchedTranscriptPaths(sessionsRoot, context, nowMs);
    if (filenameLookup.paths.length > 0) {
      return this.cacheTranscriptLookup(
        identityKey,
        nowMs,
        filenameLookup.paths,
        filenameLookup.stats,
        filenameLookup.scannedDirectoryMtimes
      );
    }

    const candidates: string[] = [];
    const deadlineAtMs = Date.now() + TranscriptLookup.TRANSCRIPT_MAX_WALL_CLOCK_MS;
    const reasonCodes = new Set<string>();
    let filesConsidered = 0;
    let filesParsed = 0;
    let remainingProbeBytes = TranscriptLookup.TRANSCRIPT_MAX_PROBE_BYTES;
    let foundFallbackContentMatch = false;
    const stack: Array<{ directory: string; depth: number }> = [{ directory: sessionsRoot, depth: 0 }];
    const scannedDirectoryMtimes = new Map<string, number>();

    while (
      stack.length > 0 &&
      !foundFallbackContentMatch &&
      candidates.length < TranscriptLookup.TRANSCRIPT_MAX_CANDIDATE_FILES &&
      filesConsidered < TranscriptLookup.TRANSCRIPT_MAX_DISCOVERY_FILES
    ) {
      if (Date.now() > deadlineAtMs) {
        reasonCodes.add('transcript_discovery_wall_clock_budget_exhausted');
        break;
      }
      const current = stack.pop();
      if (!current) {
        continue;
      }
      try {
        const directoryStat = fs.statSync(current.directory);
        if (directoryStat.isDirectory()) {
          scannedDirectoryMtimes.set(current.directory, directoryStat.mtimeMs);
        }
      } catch {
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = this.sortTranscriptDiscoveryEntries(
          fs.readdirSync(current.directory, { withFileTypes: true }),
          context.turn_started_at_ms,
          current.directory,
          sessionsRoot
        );
      } catch {
        continue;
      }
      const nextDirectories: Array<{ directory: string; depth: number }> = [];
      for (const entry of entries) {
        if (Date.now() > deadlineAtMs) {
          reasonCodes.add('transcript_discovery_wall_clock_budget_exhausted');
          break;
        }
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < TranscriptLookup.TRANSCRIPT_MAX_DEPTH) {
            nextDirectories.push({
              directory: entryPath,
              depth: current.depth + 1
            });
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }
        if (filesConsidered >= TranscriptLookup.TRANSCRIPT_MAX_DISCOVERY_FILES) {
          reasonCodes.add('transcript_discovery_file_count_budget_exhausted');
          break;
        }
        filesConsidered += 1;
        if (this.transcriptPathMayMatch(entryPath, context)) {
          candidates.push(entryPath);
          if (candidates.length >= TranscriptLookup.TRANSCRIPT_MAX_CANDIDATE_FILES) {
            reasonCodes.add('transcript_candidate_file_budget_exhausted');
            break;
          }
          continue;
        }

        let fileStat: fs.Stats;
        try {
          fileStat = fs.statSync(entryPath);
        } catch {
          continue;
        }
        if (nowMs - fileStat.mtimeMs > TranscriptLookup.TRANSCRIPT_MAX_FILE_AGE_MS) {
          reasonCodes.add('transcript_discovery_age_budget_skipped');
          continue;
        }
        if (remainingProbeBytes <= 0) {
          reasonCodes.add('transcript_probe_byte_budget_exhausted');
          continue;
        }
        const probe = this.transcriptContentMayMatchContext(entryPath, context, {
          remainingBytes: remainingProbeBytes,
          deadlineAtMs
        });
        remainingProbeBytes = probe.remainingBytes;
        if (probe.bytesRead > 0) {
          filesParsed += 1;
        }
        for (const reason of probe.reasonCodes) {
          reasonCodes.add(reason);
        }
        if (probe.matched) {
          candidates.push(entryPath);
          foundFallbackContentMatch = true;
          if (candidates.length >= TranscriptLookup.TRANSCRIPT_MAX_CANDIDATE_FILES) {
            reasonCodes.add('transcript_candidate_file_budget_exhausted');
          }
          break;
        }
      }
      for (const nextDirectory of nextDirectories.reverse()) {
        stack.push(nextDirectory);
      }
    }

    if (candidates.length >= TranscriptLookup.TRANSCRIPT_MAX_CANDIDATE_FILES) {
      reasonCodes.add('transcript_candidate_file_budget_exhausted');
    }
    if (filesConsidered >= TranscriptLookup.TRANSCRIPT_MAX_DISCOVERY_FILES) {
      reasonCodes.add('transcript_discovery_file_count_budget_exhausted');
    }

    const exhausted = reasonCodes.size > 0;
    return this.cacheTranscriptLookup(
      identityKey,
      nowMs,
      candidates,
      {
        source: exhausted ? 'budget_exhausted' : candidates.length > 0 ? 'fallback' : 'missing',
        candidateCount: candidates.length,
        filesConsidered,
        filesParsed,
        bytesRead: TranscriptLookup.TRANSCRIPT_MAX_PROBE_BYTES - remainingProbeBytes,
        exhausted,
        reasonCodes: [...reasonCodes].sort()
      },
      [...scannedDirectoryMtimes.entries()].map(([directory, mtimeMs]) => ({
        directory,
        mtimeMs
      }))
    );
  }

  private cacheTranscriptLookup(
    identityKey: string,
    refreshedAtMs: number,
    paths: string[],
    stats: TranscriptCandidateLookupStats,
    scannedDirectoryMtimes?: Array<{ directory: string; mtimeMs: number }>
  ): TranscriptCandidateLookupResult {
    this.transcriptCandidateCache = {
      identityKey,
      refreshedAtMs,
      paths: [...paths],
      stats: { ...stats, reasonCodes: [...stats.reasonCodes] },
      scannedDirectoryMtimes
    };
    return {
      paths: [...paths],
      stats,
      refreshedAtMs,
      expiresAtMs: refreshedAtMs + TranscriptLookup.TRANSCRIPT_CANDIDATE_CACHE_TTL_MS
    };
  }

  private isTranscriptCandidateCacheFresh(): boolean {
    if (!this.transcriptCandidateCache || this.transcriptCandidateCache.paths.length > 0) {
      return true;
    }
    const cachedSource =
      this.transcriptCandidateCache.stats.source === 'cache'
        ? this.transcriptCandidateCache.stats.cachedSource
        : this.transcriptCandidateCache.stats.source;
    if (cachedSource === 'budget_exhausted') {
      return this.areTranscriptScannedDirectoriesFresh();
    }
    if (cachedSource !== 'missing') {
      return true;
    }
    if (this.transcriptCandidateCache.scannedDirectoryMtimes?.length) {
      return this.areTranscriptScannedDirectoriesFresh();
    }
    if (!this.transcriptCandidateCache.stats.reasonCodes.includes('transcript_sessions_root_missing')) {
      return false;
    }
    const sessionsRoot = path.join(this.codexHome, 'sessions');
    try {
      const stat = fs.statSync(sessionsRoot);
      return stat.mtimeMs <= this.transcriptCandidateCache.refreshedAtMs;
    } catch {
      return true;
    }
  }

  private findFilenameMatchedTranscriptPaths(
    sessionsRoot: string,
    context: TurnEventContext,
    nowMs: number
  ): {
    paths: string[];
    stats: TranscriptCandidateLookupStats;
    scannedDirectoryMtimes: Array<{ directory: string; mtimeMs: number }>;
  } {
    const paths: string[] = [];
    const reasonCodes = new Set<string>();
    const scannedDirectoryMtimes = new Map<string, number>();
    const deadlineAtMs = Date.now() + TranscriptLookup.TRANSCRIPT_MAX_WALL_CLOCK_MS;
    let filesConsidered = 0;
    const stack = this.likelyTranscriptSessionDirectories(sessionsRoot, context.turn_started_at_ms).map((directory) => ({
      directory,
      depth: 0
    }));

    while (
      stack.length > 0 &&
      paths.length < TranscriptLookup.TRANSCRIPT_MAX_CANDIDATE_FILES &&
      filesConsidered < TranscriptLookup.TRANSCRIPT_MAX_FILENAME_DISCOVERY_FILES
    ) {
      if (Date.now() > deadlineAtMs) {
        reasonCodes.add('transcript_filename_discovery_wall_clock_budget_exhausted');
        break;
      }
      const current = stack.pop();
      if (!current) {
        continue;
      }
      try {
        const directoryStat = fs.statSync(current.directory);
        if (directoryStat.isDirectory()) {
          scannedDirectoryMtimes.set(current.directory, directoryStat.mtimeMs);
        }
      } catch {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = this.sortTranscriptDiscoveryEntries(
          fs.readdirSync(current.directory, { withFileTypes: true }),
          context.turn_started_at_ms,
          current.directory,
          sessionsRoot
        );
      } catch {
        continue;
      }

      const nextDirectories: Array<{ directory: string; depth: number }> = [];
      for (const entry of entries) {
        if (Date.now() > deadlineAtMs) {
          reasonCodes.add('transcript_filename_discovery_wall_clock_budget_exhausted');
          break;
        }
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < TranscriptLookup.TRANSCRIPT_MAX_DEPTH) {
            nextDirectories.push({
              directory: entryPath,
              depth: current.depth + 1
            });
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }
        filesConsidered += 1;
        if (this.transcriptPathMayMatch(entryPath, context)) {
          paths.push(entryPath);
          if (paths.length >= TranscriptLookup.TRANSCRIPT_MAX_CANDIDATE_FILES) {
            reasonCodes.add('transcript_candidate_file_budget_exhausted');
            break;
          }
        }
        if (filesConsidered >= TranscriptLookup.TRANSCRIPT_MAX_FILENAME_DISCOVERY_FILES) {
          reasonCodes.add('transcript_filename_discovery_file_count_budget_exhausted');
          break;
        }
      }
      for (const nextDirectory of nextDirectories.reverse()) {
        stack.push(nextDirectory);
      }
    }

    const exhausted = reasonCodes.size > 0;
    return {
      paths,
      stats: {
        source: 'filename',
        candidateCount: paths.length,
        filesConsidered,
        filesParsed: 0,
        bytesRead: 0,
        exhausted,
        reasonCodes: [...reasonCodes].sort()
      },
      scannedDirectoryMtimes: [...scannedDirectoryMtimes.entries()].map(([directory, mtimeMs]) => ({ directory, mtimeMs }))
    };
  }

  private likelyTranscriptSessionDirectories(sessionsRoot: string, startedAtMs: number): string[] {
    const directories = new Set<string>();
    const addDate = (date: Date, utc: boolean): void => {
      const year = utc ? date.getUTCFullYear() : date.getFullYear();
      const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
      const day = utc ? date.getUTCDate() : date.getDate();
      directories.add(path.join(sessionsRoot, String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')));
    };

    const dayMs = 24 * 60 * 60 * 1000;
    for (const offset of [-dayMs, 0, dayMs]) {
      const date = new Date(startedAtMs + offset);
      addDate(date, false);
      addDate(date, true);
    }
    return [...directories];
  }

  private areTranscriptScannedDirectoriesFresh(): boolean {
    if (!this.transcriptCandidateCache?.scannedDirectoryMtimes?.length) {
      return false;
    }
    for (const scannedDirectory of this.transcriptCandidateCache.scannedDirectoryMtimes) {
      try {
        const stat = fs.statSync(scannedDirectory.directory);
        if (!stat.isDirectory() || stat.mtimeMs !== scannedDirectory.mtimeMs) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  private emitTranscriptLookupDiagnostic(
    lookup: TranscriptCandidateLookupResult,
    context: TurnEventContext,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): void {
    const metadata = serializeTranscriptLookupMetadata(lookup);
    const diagnosticKey = [
      context.session_id,
      metadata.source,
      metadata.cached_source ?? '',
      metadata.candidate_count,
      metadata.files_considered,
      metadata.files_parsed,
      metadata.bytes_read,
      metadata.exhausted,
      metadata.reason_codes.join(',')
    ].join('|');
    if (diagnosticKey === this.lastTranscriptLookupDiagnosticKey) {
      return;
    }
    this.lastTranscriptLookupDiagnosticKey = diagnosticKey;
    emit({
      event: CANONICAL_EVENT.codex.transcriptLookup,
      thread_id: context.thread_id,
      turn_id: context.turn_id,
      session_id: context.session_id,
      detail: `transcript_lookup source=${metadata.source} candidates=${metadata.candidate_count} files_considered=${metadata.files_considered} exhausted=${metadata.exhausted} reasons=${metadata.reason_codes.join(',') || 'none'}`,
      transcript_lookup_source: metadata.source,
      ...(metadata.cached_source ? { transcript_lookup_cached_source: metadata.cached_source } : {}),
      transcript_lookup_candidate_count: metadata.candidate_count,
      transcript_lookup_files_considered: metadata.files_considered,
      transcript_lookup_files_parsed: metadata.files_parsed,
      transcript_lookup_bytes_read: metadata.bytes_read,
      transcript_lookup_exhausted: metadata.exhausted,
      transcript_lookup_reason_codes: metadata.reason_codes,
      transcript_lookup_cache_refreshed_at_ms: metadata.cache_refreshed_at_ms,
      transcript_lookup_cache_expires_at_ms: metadata.cache_expires_at_ms
    });
  }

  private transcriptCandidateIdentityKey(context: TurnEventContext): string {
    return [context.session_id, context.thread_id, context.turn_id].join('|');
  }

  private transcriptPathMayMatch(transcriptPath: string, context: TurnEventContext): boolean {
    const normalized = transcriptPath.toLowerCase();
    return [context.session_id, context.thread_id, context.turn_id].some((identifier) => normalized.includes(identifier.toLowerCase()));
  }

  private sortTranscriptDiscoveryEntries(
    entries: fs.Dirent[],
    activeStartedAtMs?: number,
    currentDirectory?: string,
    sessionsRoot?: string
  ): fs.Dirent[] {
    return [...entries].sort((left, right) => {
      const leftTranscript = left.isFile() && left.name.endsWith('.jsonl');
      const rightTranscript = right.isFile() && right.name.endsWith('.jsonl');
      if (leftTranscript !== rightTranscript) {
        return leftTranscript ? -1 : 1;
      }
      if (leftTranscript && rightTranscript) {
        const leftTimestampMs = parseCodexRolloutTimestampMs(left.name);
        const rightTimestampMs = parseCodexRolloutTimestampMs(right.name);
        if (activeStartedAtMs !== undefined && (leftTimestampMs !== null || rightTimestampMs !== null)) {
          if (leftTimestampMs === null) {
            return 1;
          }
          if (rightTimestampMs === null) {
            return -1;
          }
          const proximity = Math.abs(leftTimestampMs - activeStartedAtMs) - Math.abs(rightTimestampMs - activeStartedAtMs);
          if (proximity !== 0) {
            return proximity;
          }
          return rightTimestampMs - leftTimestampMs;
        }
        return right.name.localeCompare(left.name);
      }
      const leftDirectory = left.isDirectory();
      const rightDirectory = right.isDirectory();
      if (leftDirectory !== rightDirectory) {
        return leftDirectory ? -1 : 1;
      }
      if (leftDirectory && rightDirectory && activeStartedAtMs !== undefined && currentDirectory && sessionsRoot) {
        const leftRange = parseCodexSessionsDirectoryRangeMs(path.join(currentDirectory, left.name), sessionsRoot);
        const rightRange = parseCodexSessionsDirectoryRangeMs(path.join(currentDirectory, right.name), sessionsRoot);
        if (leftRange || rightRange) {
          if (!leftRange) {
            return 1;
          }
          if (!rightRange) {
            return -1;
          }
          const proximity = distanceToTimeRangeMs(activeStartedAtMs, leftRange) - distanceToTimeRangeMs(activeStartedAtMs, rightRange);
          if (proximity !== 0) {
            return proximity;
          }
        }
      }
      return right.name.localeCompare(left.name);
    });
  }

  private transcriptContentMayMatchContext(
    transcriptPath: string,
    context: TurnEventContext,
    budget: { remainingBytes: number; deadlineAtMs: number }
  ): {
    matched: boolean;
    bytesRead: number;
    remainingBytes: number;
    reasonCodes: string[];
  } {
    const reasonCodes: string[] = [];
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return {
        matched: false,
        bytesRead: 0,
        remainingBytes: budget.remainingBytes,
        reasonCodes
      };
    }
    const bytesToRead = Math.min(stat.size, budget.remainingBytes);
    let content = '';
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        content = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return {
        matched: false,
        bytesRead: 0,
        remainingBytes: budget.remainingBytes,
        reasonCodes
      };
    }
    if (bytesToRead < stat.size) {
      reasonCodes.push('transcript_probe_file_byte_budget_exhausted');
    }
    for (const line of content.split(/\r?\n/)) {
      if (Date.now() > budget.deadlineAtMs) {
        reasonCodes.push('transcript_discovery_wall_clock_budget_exhausted');
        return {
          matched: false,
          bytesRead: bytesToRead,
          remainingBytes: budget.remainingBytes - bytesToRead,
          reasonCodes
        };
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const parsed = parseJsonRecord(trimmed);
      if (!parsed) {
        continue;
      }
      const payload = asRecord(parsed.payload);
      const item = this.readTranscriptProbeResponseItem(parsed);
      const threadId = this.readTranscriptProbeString(['thread_id', 'threadId'], parsed, payload, item);
      const turnId = this.readTranscriptProbeString(['turn_id', 'turnId'], parsed, payload, item);
      const sessionId = this.readTranscriptProbeString(['session_id', 'sessionId'], parsed, payload, item);
      if (threadId === context.thread_id || turnId === context.turn_id || sessionId === context.session_id) {
        return {
          matched: true,
          bytesRead: bytesToRead,
          remainingBytes: budget.remainingBytes - bytesToRead,
          reasonCodes
        };
      }
    }
    return {
      matched: false,
      bytesRead: bytesToRead,
      remainingBytes: budget.remainingBytes - bytesToRead,
      reasonCodes
    };
  }

  private readTranscriptProbeResponseItem(record: Record<string, unknown>): Record<string, unknown> | null {
    const payload = asRecord(record.payload);
    if (payload?.type === 'response_item') {
      return asRecord(payload.item);
    }
    if (record.type === 'response_item') {
      return payload;
    }
    return null;
  }

  private readTranscriptProbeString(keys: string[], ...records: Array<Record<string, unknown> | null | undefined>): string | undefined {
    for (const record of records) {
      if (!record) {
        continue;
      }
      for (const key of keys) {
        const value = readString(record[key]);
        if (value) {
          return value;
        }
      }
    }
    return undefined;
  }

  private detailExcerpt(value: string, maxLength = 180): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength)}...`;
  }

  private readTranscriptTerminalEvidence(
    record: Record<string, unknown>,
    transcriptPath: string,
    context: TurnEventContext,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): TranscriptTerminalEvidence | null {
    const payload = asRecord(record.payload) ?? record;
    const payloadType = readString(payload.type);
    const terminal = this.mapTranscriptTerminalType(payloadType);
    if (!terminal) {
      return null;
    }

    const lineageMismatch = this.describeTranscriptLineageMismatch(payload, transcriptPath, context);
    if (lineageMismatch) {
      emit({
        event: CANONICAL_EVENT.codex.sideOutput,
        detail: this.detailExcerpt(`session_transcript_terminal_ignored ${lineageMismatch}`),
        thread_id: context.thread_id,
        turn_id: context.turn_id,
        session_id: context.session_id,
        terminal_source: 'session_transcript'
      });
      return null;
    }

    return {
      terminal,
      last_agent_message: readString(payload.last_agent_message) ?? readString(payload.lastAgentMessage),
      completed_at_ms: normalizeEpochMs(payload.completed_at ?? payload.completedAt) ?? normalizeTimestampMs(record.timestamp),
      duration_ms: readNumber(payload.duration_ms ?? payload.durationMs),
      time_to_first_token_ms: readNumber(payload.time_to_first_token_ms ?? payload.timeToFirstTokenMs)
    };
  }

  private describeTranscriptLineageMismatch(
    payload: Record<string, unknown>,
    transcriptPath: string,
    context: TurnEventContext
  ): string | null {
    const eventThreadId = readString(payload.thread_id) ?? readString(payload.threadId);
    const eventTurnId = readString(payload.turn_id) ?? readString(payload.turnId);
    const eventSessionId = readString(payload.session_id) ?? readString(payload.sessionId);
    const pathContainsThread = transcriptPath.includes(context.thread_id);

    if (eventTurnId !== context.turn_id) {
      return `reason=turn_mismatch active_turn_id=${context.turn_id} event_turn_id=${eventTurnId ?? 'missing'}`;
    }
    if (eventThreadId && eventThreadId !== context.thread_id) {
      return `reason=thread_mismatch active_thread_id=${context.thread_id} event_thread_id=${eventThreadId}`;
    }
    if (!eventThreadId && !pathContainsThread) {
      return `reason=thread_unattributed active_thread_id=${context.thread_id}`;
    }
    if (eventSessionId && eventSessionId !== context.session_id) {
      return `reason=session_mismatch active_session_id=${context.session_id} event_session_id=${eventSessionId}`;
    }
    return null;
  }

  private mapTranscriptTerminalType(
    type: string | undefined
  ): 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required' | null {
    if (type === 'task_complete') {
      return 'turn/completed';
    }
    if (type === 'task_failed' || type === 'turn_failed' || type === 'turn/failed') {
      return 'turn/failed';
    }
    if (type === 'task_cancelled' || type === 'turn_cancelled' || type === 'turn/cancelled') {
      return 'turn/cancelled';
    }
    if (type === 'task_input_required' || type === REASON_CODES.turnInputRequired || type === 'turn/input_required') {
      return 'turn/input_required';
    }
    return null;
  }
}
