import crypto from 'node:crypto';

/** Stable per-device fingerprint: sha256(ip + '|' + user-agent), truncated. */
export function deviceFingerprint(ip: string, ua: string): string {
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 24);
}
