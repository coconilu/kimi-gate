/**
 * Password hashing with capability detection.
 *
 * Node 24 ships `crypto.argon2` (async, callback/promisify based). When the
 * runtime does not provide it, we fall back to `crypto.scrypt`. The stored
 * hash is self-describing so both algorithms can coexist in one database:
 *
 *   argon2id$<m>,<t>,<p>$<salt-b64>$<hash-b64>
 *   scrypt$<N>,<r>,<p>$<salt-b64>$<hash-b64>
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

interface Argon2Params {
  message: string;
  nonce: Buffer;
  parallelism: number;
  tagLength: number;
  memory: number;
  passes: number;
}

const argon2: ((algorithm: string, params: Argon2Params, cb: (err: Error | null, derivedKey: Buffer) => void) => void) | undefined =
  (crypto as unknown as { argon2?: unknown }).argon2 as typeof argon2;

const argon2Async = argon2 ? promisify(argon2) : null;

const ARGON2 = { memory: 64 * 1024, passes: 3, parallelism: 1, tagLength: 32 };
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function activeAlgorithm(): 'argon2id' | 'scrypt' {
  return argon2Async ? 'argon2id' : 'scrypt';
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  if (argon2Async) {
    const hash = await argon2Async('argon2id', {
      message: password,
      nonce: salt,
      parallelism: ARGON2.parallelism,
      tagLength: ARGON2.tagLength,
      memory: ARGON2.memory,
      passes: ARGON2.passes,
    });
    return `argon2id$${ARGON2.memory},${ARGON2.passes},${ARGON2.parallelism}$${salt.toString('base64')}$${hash.toString('base64')}`;
  }
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N},${SCRYPT.r},${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [algo, paramStr, saltB64, hashB64] = stored.split('$');
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const [a, b, c] = paramStr.split(',').map(Number);

    let actual: Buffer;
    if (algo === 'argon2id' && argon2Async) {
      actual = await argon2Async('argon2id', {
        message: password,
        nonce: salt,
        parallelism: c,
        tagLength: expected.length,
        memory: a,
        passes: b,
      });
    } else if (algo === 'scrypt') {
      actual = crypto.scryptSync(password, salt, expected.length, { N: a, r: b, p: c });
    } else {
      return false;
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
