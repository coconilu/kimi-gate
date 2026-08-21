/**
 * CSRF via signed double-submit token.
 * Token = <random>.<hmac(random, SESSION_SECRET)>; rendered into forms and
 * also set as a (non-httpOnly) cookie. Submissions must present the same
 * token in the body field / X-CSRF-Token header.
 */
import crypto from 'node:crypto';

export const CSRF_COOKIE = 'kg_csrf';

export function issueCsrf(secret: string): string {
  const rand = crypto.randomBytes(16).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update('csrf:' + rand).digest('base64url');
  return `${rand}.${sig}`;
}

export function verifyCsrf(secret: string, token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const rand = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret).update('csrf:' + rand).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
