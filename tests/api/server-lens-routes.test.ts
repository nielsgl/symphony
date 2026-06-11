import { describe, expect, it, vi } from 'vitest';

import {
  LocalApiServer,
  closeServerAfterEach,
  makeState
} from './server-test-harness';

let server: LocalApiServer | null = null;

closeServerAfterEach(
  () => server,
  (nextServer) => {
    server = nextServer;
  }
);

const HARNESS_BASE = {
  snapshotSource: { getStateSnapshot: () => makeState() },
  refreshSource: { tick: vi.fn(async () => undefined) },
  dashboardConfig: {
    dashboard_enabled: true,
    refresh_ms: 4000,
    render_interval_ms: 1000,
    asset_revision: 'lens-rev-test'
  }
} as const;

async function withServer(): Promise<{ server: LocalApiServer; baseUrl: string }> {
  server = new LocalApiServer(HARNESS_BASE);
  await server.listen();
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('LocalApiServer Living Agent Lens routes', () => {
  it('serves a parallel /dashboard HTML route that mirrors the legacy /', async () => {
    const { baseUrl } = await withServer();
    const root = await fetch(`${baseUrl}/`);
    const dashboard = await fetch(`${baseUrl}/dashboard`);
    expect(root.status).toBe(200);
    expect(dashboard.status).toBe(200);
    const rootBody = await root.text();
    const dashboardBody = await dashboard.text();
    expect(dashboardBody).toBe(rootBody);
    expect(dashboardBody).toContain('Symphony Operator Control');
  });

  it('serves /lens HTML referencing the lens client + styles', async () => {
    const { baseUrl } = await withServer();
    const response = await fetch(`${baseUrl}/lens`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('Living Agent Lens');
    expect(body).toContain('/lens/client.js?v=lens-rev-test');
    expect(body).toContain('/lens/styles.css?v=lens-rev-test');
    expect(body).toContain('id="lens-root"');
  });

  it('serves the lens client bundle', async () => {
    const { baseUrl } = await withServer();
    const response = await fetch(`${baseUrl}/lens/client.js?v=lens-rev-test`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/javascript');
    const body = await response.text();
    expect(body).toContain('symphony-lens-asset-revision');
    expect(body.length).toBeGreaterThan(1000);
  });

  it('serves the lens stylesheet with the spec tokens', async () => {
    const { baseUrl } = await withServer();
    const response = await fetch(`${baseUrl}/lens/styles.css?v=lens-rev-test`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/css');
    const body = await response.text();
    expect(body).toContain('--lens-blue: #5aaeff');
    expect(body).toContain('.lens-circle');
    expect(body).toContain('aspect-ratio: 1 / 1');
    expect(body).toContain('.lens-classic-link');
    // The fake macOS traffic-light treatment was removed; no CSS class for it
    // should remain in the stylesheet.
    expect(body).not.toContain('.lens-traffic-lights');
    expect(body).not.toContain('.lens-tl-red');
    expect(body).not.toContain('.lens-tl-amber');
    expect(body).not.toContain('.lens-tl-green');
  });

  it('does not render fake macOS traffic-light dots in the lens client bundle', async () => {
    const { baseUrl } = await withServer();
    const response = await fetch(`${baseUrl}/lens/client.js?v=lens-rev-test`);
    const body = await response.text();
    // Spans + class names from the previous chrome must be gone from the
    // compiled bundle. (The bundle is a single IIFE string, so substring
    // checks are sufficient.)
    expect(body).not.toContain('lens-traffic-lights');
    expect(body).not.toContain('lens-tl-red');
    expect(body).not.toContain('lens-tl-amber');
    expect(body).not.toContain('lens-tl-green');
    expect(body).not.toContain('lens-titlebar-name');
  });

  it('serves /api/v1/living-agent-lens with the normalized view-model envelope', async () => {
    const { baseUrl } = await withServer();
    const response = await fetch(`${baseUrl}/api/v1/living-agent-lens`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toHaveProperty('shell');
    expect(payload).toHaveProperty('queue');
    expect(payload).toHaveProperty('lens');
    expect(payload).toHaveProperty('interlocks');
    expect(payload).toHaveProperty('evidence_path');
    expect(payload).toHaveProperty('actions');
    expect(payload).toHaveProperty('footer');
    expect(payload).toHaveProperty('missing_capabilities');
    expect(Array.isArray((payload as { interlocks: unknown }).interlocks)).toBe(true);
  });

  it('exposes the Preview Lens switcher on the legacy dashboard HTML', async () => {
    const { baseUrl } = await withServer();
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();
    expect(body).toContain('id="preview-lens-link"');
    expect(body).toContain('href="/lens"');
    expect(body).toContain('Preview Lens');
  });
});
