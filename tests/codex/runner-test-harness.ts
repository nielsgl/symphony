import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { expect } from 'vitest';

import type { CodexRunnerStartInput } from '../../src/codex';

export class FakeProcess {
  pid: number | null = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  private readonly exitEmitter = new EventEmitter();
  readonly writes: string[] = [];
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  killed = false;
  stdin = {
    write: (data: string) => {
      this.writes.push(data.trim());
    }
  };

  kill(signal?: NodeJS.Signals | number): void {
    this.signals.push(signal);
    this.killed = true;
  }

  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitEmitter.once(event, listener);
  }

  emitStdout(line: string): void {
    this.stdout.emit('data', Buffer.from(line, 'utf8'));
  }

  emitStderr(line: string): void {
    this.stderr.emit('data', Buffer.from(line, 'utf8'));
  }

  emitExit(code: number | null = 1): void {
    this.exitEmitter.emit('exit', code, null);
  }
}

export function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-runner-'));
}

export function makeStartInput(workspaceCwd: string, overrides: Partial<CodexRunnerStartInput> = {}): CodexRunnerStartInput {
  return {
    command: 'codex app-server',
    workspaceCwd,
    prompt: 'hello',
    title: 'ABC-1: Title',
    readTimeoutMs: 1000,
    turnTimeoutMs: 1000,
    ...overrides
  };
}

export function parseWrittenMessages(fake: FakeProcess): Array<Record<string, unknown>> {
  return fake.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const GENERATED_CONTRACT_BUNDLE = path.join(
  process.cwd(),
  'tests/fixtures/codex-app-server-contract/good/schema/codex_app_server_protocol.schemas.json'
);

export interface GeneratedSchema {
  required?: string[];
  properties?: Record<string, GeneratedSchema | boolean>;
  type?: string | string[];
  enum?: unknown[];
  oneOf?: GeneratedSchema[];
  anyOf?: GeneratedSchema[];
  items?: GeneratedSchema;
  $ref?: string;
}

export function generatedDefinitions(): Record<string, GeneratedSchema> {
  const bundle = JSON.parse(fs.readFileSync(GENERATED_CONTRACT_BUNDLE, 'utf8')) as {
    definitions: Record<string, GeneratedSchema>;
  };
  return bundle.definitions;
}

export function generatedDefinition(name: string): GeneratedSchema {
  const definitions = generatedDefinitions();
  const definition = definitions[name] ?? definitions[`v2/${name}`];
  if (!definition) {
    throw new Error(`Generated contract fixture is missing ${name}`);
  }
  return definition;
}

export function generatedRef(schema: GeneratedSchema): GeneratedSchema {
  if (!schema.$ref) {
    return schema;
  }
  return generatedDefinition(schema.$ref.split('/').at(-1) ?? schema.$ref);
}

export function expectGeneratedMethod(unionName: string, method: string): void {
  const union = generatedDefinition(unionName);
  const serialized = JSON.stringify(union);
  expect(serialized).toContain(`"${method}"`);
}

export function expectGeneratedPayloadShape(
  definitionName: string,
  payload: Record<string, unknown>,
  expectedFields: string[]
): void {
  const schema = generatedDefinition(definitionName);
  expect(schema.properties).toBeTruthy();

  for (const field of schema.required ?? []) {
    expect(payload).toHaveProperty(field);
  }

  for (const field of expectedFields) {
    const property = schema.properties?.[field];
    expect(property).toBeTruthy();
    expect(payload).toHaveProperty(field);
    expectValueMatchesGeneratedSchema(property, payload[field], `${definitionName}.${field}`);
  }
}

export function expectValueMatchesGeneratedSchema(schema: GeneratedSchema | boolean | undefined, value: unknown, label: string): void {
  if (schema === true || schema === undefined) {
    return;
  }
  if (schema === false) {
    throw new Error(`${label} is forbidden by generated schema`);
  }
  if (schema.$ref) {
    expectValueMatchesGeneratedSchema(generatedRef(schema), value, label);
    return;
  }
  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf ?? [];
    const errors: string[] = [];
    for (const variant of variants) {
      try {
        expectValueMatchesGeneratedSchema(variant, value, label);
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`${label} did not match generated variants: ${errors.join('; ')}`);
  }

  const type = schema.type;
  const allowedTypes = Array.isArray(type) ? type : type ? [type] : [];
  if (value === null && allowedTypes.includes('null')) {
    return;
  }
  if (schema.enum) {
    expect(schema.enum).toContain(value);
    return;
  }
  if (allowedTypes.includes('string')) {
    expect(typeof value).toBe('string');
  } else if (allowedTypes.includes('boolean')) {
    expect(typeof value).toBe('boolean');
  } else if (allowedTypes.includes('array')) {
    expect(Array.isArray(value)).toBe(true);
    if (schema.items && Array.isArray(value)) {
      for (const item of value) {
        expectValueMatchesGeneratedSchema(schema.items, item, `${label}[]`);
      }
    }
  } else if (allowedTypes.includes('object') || schema.properties) {
    expect(value && typeof value === 'object' && !Array.isArray(value)).toBe(true);
    const record = value as Record<string, unknown>;
    for (const field of schema.required ?? []) {
      expect(record).toHaveProperty(field);
    }
    for (const [field, property] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(record, field)) {
        expectValueMatchesGeneratedSchema(property, record[field], `${label}.${field}`);
      }
    }
  }
}

export function writeTranscriptRecord(codexHome: string, filename: string, record: Record<string, unknown>): void {
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.appendFileSync(path.join(sessionsDir, filename), `${JSON.stringify(record)}\n`, 'utf8');
}

export function appendTranscriptText(codexHome: string, filename: string, text: string): void {
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.appendFileSync(path.join(sessionsDir, filename), text, 'utf8');
}
