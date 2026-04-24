interface ParsedSshTarget {
  destination: string;
  port?: string;
}

function isNumericPort(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function parseBracketedTarget(target: string): ParsedSshTarget | null {
  const match = target.match(/^([^@\s]+)@(\[[^\]]+\])(?::([0-9]+))?$/);
  if (match) {
    const [, user, host, port] = match;
    return {
      destination: `${user}@${host}`,
      ...(port ? { port } : {})
    };
  }

  const bare = target.match(/^(\[[^\]]+\])(?::([0-9]+))?$/);
  if (!bare) {
    return null;
  }

  const [, host, port] = bare;
  return {
    destination: host,
    ...(port ? { port } : {})
  };
}

function parseSingleColonTarget(target: string): ParsedSshTarget | null {
  const userHostPort = target.match(/^([^@\s]+)@([^:\s]+):([0-9]+)$/);
  if (userHostPort) {
    const [, user, host, port] = userHostPort;
    return {
      destination: `${user}@${host}`,
      port
    };
  }

  const hostPort = target.match(/^([^:@\s]+):([0-9]+)$/);
  if (hostPort) {
    const [, host, port] = hostPort;
    return {
      destination: host,
      port
    };
  }

  return null;
}

export function parseSshTarget(target: string): ParsedSshTarget {
  const trimmed = target.trim();
  if (!trimmed) {
    return { destination: '' };
  }

  const bracketed = parseBracketedTarget(trimmed);
  if (bracketed) {
    return bracketed;
  }

  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const singleColon = parseSingleColonTarget(trimmed);
    if (singleColon && (!singleColon.port || isNumericPort(singleColon.port))) {
      return singleColon;
    }
  }

  return { destination: trimmed };
}

export function buildSshSpawnArgs(target: string, remoteCommand: string): string[] {
  const parsed = parseSshTarget(target);
  if (!parsed.destination) {
    return ['-T', remoteCommand];
  }

  if (parsed.port) {
    return ['-T', '-p', parsed.port, parsed.destination, remoteCommand];
  }

  return ['-T', parsed.destination, remoteCommand];
}
