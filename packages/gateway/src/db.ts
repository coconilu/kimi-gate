/**
 * SQLite storage via the built-in `node:sqlite` module (Node >= 22.5,
 * flag-free on Node 24). Single file, zero external services.
 */
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS login_attempts (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      ip      TEXT NOT NULL,
      ua      TEXT NOT NULL,
      device  TEXT NOT NULL,
      result  TEXT NOT NULL,   -- success | bad_password | bad_totp | rate_limited | banned | bad_csrf
      reason  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_ts ON login_attempts(ts);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_device ON login_attempts(device);

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip         TEXT NOT NULL,
      ua         TEXT NOT NULL,
      admin_ok   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS rl_events (
      device TEXT NOT NULL,
      ts     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rl_events_device_ts ON rl_events(device, ts);

    CREATE TABLE IF NOT EXISTS banned_ips (
      ip         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      reason     TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}
