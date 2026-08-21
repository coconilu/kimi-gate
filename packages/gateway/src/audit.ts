import type { Db } from './db.js';

export type LoginResult =
  | 'success'
  | 'bad_password'
  | 'bad_totp'
  | 'rate_limited'
  | 'banned'
  | 'bad_csrf';

export interface LoginAttempt {
  id: number;
  ts: number;
  ip: string;
  ua: string;
  device: string;
  result: LoginResult;
  reason: string;
}

export function recordAttempt(
  db: Db,
  entry: { ip: string; ua: string; device: string; result: LoginResult; reason?: string },
): void {
  db.prepare(
    'INSERT INTO login_attempts (ts, ip, ua, device, result, reason) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(Date.now(), entry.ip, entry.ua, entry.device, entry.result, entry.reason ?? '');
}

export interface LogFilter {
  result?: string;
  ip?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export function queryAttempts(db: Db, filter: LogFilter = {}): LoginAttempt[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.result) { where.push('result = ?'); args.push(filter.result); }
  if (filter.ip) { where.push('ip = ?'); args.push(filter.ip); }
  if (filter.from !== undefined) { where.push('ts >= ?'); args.push(filter.from); }
  if (filter.to !== undefined) { where.push('ts <= ?'); args.push(filter.to); }
  const sql =
    'SELECT id, ts, ip, ua, device, result, reason FROM login_attempts' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?';
  args.push(filter.limit ?? 200, filter.offset ?? 0);
  return db.prepare(sql).all(...args) as unknown as LoginAttempt[];
}

const CSV_HEADER = 'id,ts,iso_time,ip,user_agent,device,result,reason';

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function attemptsToCsv(rows: LoginAttempt[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [r.id, r.ts, new Date(r.ts).toISOString(), r.ip, r.ua, r.device, r.result, r.reason]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
