import { describe, expect, it } from 'vitest';

import { buildSshSpawnArgs, parseSshTarget } from '../../src/codex/ssh-target';

describe('ssh target normalization', () => {
  it('parses host:port targets into destination + ssh -p port', () => {
    expect(parseSshTarget('localhost:2222')).toEqual({
      destination: 'localhost',
      port: '2222'
    });
    expect(buildSshSpawnArgs('localhost:2222', 'bash -lc "echo ready"')).toEqual([
      '-T',
      '-p',
      '2222',
      'localhost',
      'bash -lc "echo ready"'
    ]);
  });

  it('keeps bracketed IPv6 host:port targets intact and extracts port', () => {
    expect(parseSshTarget('[::1]:2200')).toEqual({
      destination: '[::1]',
      port: '2200'
    });
    expect(parseSshTarget('root@[::1]:2200')).toEqual({
      destination: 'root@[::1]',
      port: '2200'
    });
  });

  it('leaves unbracketed IPv6-style targets unchanged', () => {
    expect(parseSshTarget('::1:2200')).toEqual({
      destination: '::1:2200'
    });
    expect(buildSshSpawnArgs('::1:2200', 'run')).toEqual(['-T', '::1:2200', 'run']);
  });

  it('keeps user prefix while parsing user@host:port', () => {
    expect(parseSshTarget('root@127.0.0.1:2200')).toEqual({
      destination: 'root@127.0.0.1',
      port: '2200'
    });
    expect(buildSshSpawnArgs('root@127.0.0.1:2200', 'run')).toEqual(['-T', '-p', '2200', 'root@127.0.0.1', 'run']);
  });

  it('falls back to destination-only for plain hosts and non-port suffixes', () => {
    expect(parseSshTarget('build-worker')).toEqual({
      destination: 'build-worker'
    });
    expect(parseSshTarget('host:notaport')).toEqual({
      destination: 'host:notaport'
    });
  });
});
