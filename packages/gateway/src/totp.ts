/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s step) with no external dependency.
 */
import crypto from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secret: string, counter: number, digits = 6): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: string, timeMs = Date.now(), stepSec = 30, digits = 6): string {
  return hotp(secret, Math.floor(timeMs / 1000 / stepSec), digits);
}

/** Verify with +/- `window` steps of clock skew tolerance, constant-time. */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { timeMs?: number; window?: number; stepSec?: number; digits?: number } = {},
): boolean {
  const { timeMs = Date.now(), window = 1, stepSec = 30, digits = 6 } = opts;
  if (!/^\d+$/.test(code)) return false;
  const counter = Math.floor(timeMs / 1000 / stepSec);
  let match = false;
  for (let i = -window; i <= window; i++) {
    if (counter + i < 0) continue;
    const expected = hotp(secret, counter + i, digits);
    const a = Buffer.from(expected);
    const b = Buffer.from(code.padStart(digits, '0'));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) match = true;
  }
  return match;
}
