import { afterEach, describe, expect, it, vi } from 'vitest';

const { buildRequest, main } = require('../../scripts/drain-mode-control.js') as {
  buildRequest: (argv: string[]) => { method: 'GET' | 'POST'; url: string; body: Record<string, unknown> | null };
  main: (argv: string[]) => Promise<number>;
};

describe('drain-mode-control script', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['status', 'GET', '/api/v1/drain-mode', null],
    ['enter', 'POST', '/api/v1/drain-mode/enter', { reason: 'maintenance' }],
    ['exit', 'POST', '/api/v1/drain-mode/exit', { reason: 'maintenance-complete' }],
    ['wait', 'POST', '/api/v1/drain-mode/wait', { timeout_ms: 250 }],
    ['shutdown', 'POST', '/api/v1/drain-mode/shutdown', { reason: 'upgrade', override: true }]
  ])('selects the %s endpoint and body', (command, method, endpoint, body) => {
    const args =
      command === 'enter'
        ? [command, '--url', 'http://127.0.0.1:3030', '--reason', 'maintenance']
        : command === 'exit'
          ? [command, '--url', 'http://localhost:4040/', '--reason=maintenance-complete']
          : command === 'wait'
            ? [command, '--url', 'http://127.0.0.1:3030', '--timeout-ms', '250']
            : command === 'shutdown'
              ? [command, '--url', 'http://127.0.0.1:3030', '--reason', 'upgrade', '--override']
              : [command, '--url', 'http://127.0.0.1:3030'];

    expect(buildRequest(args)).toEqual({
      method,
      url: `${command === 'exit' ? 'http://localhost:4040' : 'http://127.0.0.1:3030'}${endpoint}`,
      body
    });
  });

  it('returns a non-zero exit code for non-2xx API responses while printing JSON', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ success: false, reason_code: 'blocked' })
    })));

    await expect(main(['status'])).resolves.toBe(1);
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ success: false, reason_code: 'blocked' }, null, 2) + '\n');
  });

  it('rejects invalid timeout values before issuing a request', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(main(['wait', '--timeout-ms', '-1'])).rejects.toThrow('--timeout-ms must be a non-negative integer');
    expect(fetch).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
