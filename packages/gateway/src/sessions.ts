/**
 * SQLite-backed sessions + signed httpOnly cookies.
 * Cookie value:  <session-id>.<hmac-sha256-hex(session-id, SESSION_SECRET)>
 */
import crypto from 'node:crypto';
import type { Db } from './db.js';

export const SESSION_COOKIE = 'kg_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Session {
  id: string;
  created_at: number;
  expires_at: number;
  ip: string;
  ua: string;
  admin_ok: number;
}

function sign(id: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(id).digest('hex');
}

export function createSession(db: Db, secret: string, ip: string, ua: string): { id: string; cookie: string } {
  const id = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, created_at, expires_at, ip, ua, admin_ok) VALUES (?, ?, ?, ?, ?, 0)',
  ).run(id, now, now + SESSION_TTL_MS, ip, ua);
  return { id, cookie: `${id}.${sign(id, secret)}` };
}

export function getSession(db: Db, secret: string, cookieValue: string | undefined): Session | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expect = sign(id, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  return row;
}

export function markAdminVerified(db: Db, id: string): void {
  db.prepare('UPDATE sessions SET admin_ok = 1 WHERE id = ?').run(id);
}

export function revokeSession(db: Db, id: string): boolean {
  const res = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

export function listSessions(db: Db): Session[] {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as unknown as Session[];
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
