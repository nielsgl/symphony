import fs from 'node:fs';
import path from 'node:path';

export interface PersistenceStatement {
  run(...args: unknown[]): void;
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
}

export interface PersistenceDatabase {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): PersistenceStatement;
}

export interface PersistenceStoreContext {
  dbPath: string;
  retentionDays: number;
  nowMs: () => number;
  db: PersistenceDatabase;
}

interface CreatePersistenceStoreContextOptions {
  dbPath: string;
  retentionDays: number;
  nowMs: () => number;
}

export function createPersistenceStoreContext(options: CreatePersistenceStoreContextOptions): PersistenceStoreContext {
  const parent = path.dirname(options.dbPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(parent, 0o700);
  } catch {
    // Best effort only.
  }

  const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => PersistenceDatabase };
  const db = new sqlite.DatabaseSync(options.dbPath);
  try {
    fs.chmodSync(options.dbPath, 0o600);
  } catch {
    // Best effort only.
  }

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  return {
    dbPath: options.dbPath,
    retentionDays: options.retentionDays,
    nowMs: options.nowMs,
    db
  };
}
