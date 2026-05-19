import type { ServerResponse } from 'node:http';

import { redactUnknown } from '../../security/redaction';
import type { ApiEventEnvelope } from '../types';

export interface StreamDiagnosticsState {
  lastClientConnectedAtMs: number | null;
  lastClientDisconnectedAtMs: number | null;
  lastSnapshotBroadcastAtMs: number | null;
  lastSnapshotBroadcastLatencyMs: number | null;
  lastSnapshotBroadcastStatus: 'ok' | 'failed' | 'no_clients' | null;
  lastSnapshotBroadcastError: string | null;
}

export function createStreamDiagnosticsState(): StreamDiagnosticsState {
  return {
    lastClientConnectedAtMs: null,
    lastClientDisconnectedAtMs: null,
    lastSnapshotBroadcastAtMs: null,
    lastSnapshotBroadcastLatencyMs: null,
    lastSnapshotBroadcastStatus: null,
    lastSnapshotBroadcastError: null
  };
}

export function serializeEventEnvelope(
  type: ApiEventEnvelope['type'],
  payload: unknown,
  nextEventId: () => number,
  nowMs: () => number
): { message: string; bytes: number } {
  const envelope: ApiEventEnvelope = {
    event_id: nextEventId(),
    generated_at: new Date(nowMs()).toISOString(),
    type,
    payload: redactUnknown(payload)
  };
  const message = `id: ${envelope.event_id}\nevent: symphony\ndata: ${JSON.stringify(envelope)}\n\n`;
  return {
    message,
    bytes: Buffer.byteLength(message, 'utf8')
  };
}

export function writeEventMessage(
  eventClients: Map<number, ServerResponse>,
  message: string
): { failedClientCount: number; error: string | null } {
  let failedClientCount = 0;
  let errorMessage: string | null = null;
  for (const [clientId, response] of eventClients.entries()) {
    try {
      response.write(message);
    } catch (error) {
      failedClientCount += 1;
      errorMessage = error instanceof Error ? error.message : String(error);
      eventClients.delete(clientId);
    }
  }
  return { failedClientCount, error: errorMessage };
}
