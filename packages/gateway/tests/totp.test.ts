import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, hotp, totp, verifyTotp, generateTotpSecret } from '../src/totp.js';

// RFC 4226 测试向量: secret = ASCII "12345678901234567890"
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_HOTP = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];

test('base32 编解码往返', () => {
  const buf = Buffer.from('12345678901234567890', 'ascii');
  assert.equal(base32Encode(buf), RFC_SECRET_B32);
  assert.deepEqual(base32Decode(RFC_SECRET_B32), buf);
});

test('HOTP 符合 RFC 4226 测试向量', () => {
  RFC_HOTP.forEach((expected, counter) => {
    assert.equal(hotp(RFC_SECRET_B32, counter), expected, `counter=${counter}`);
  });
});

test('TOTP 生成与校验（固定时钟）', () => {
  const secret = generateTotpSecret();
  assert.equal(secret.length, 32);
  const t0 = 1_700_000_000_000;
  const code = totp(secret, t0);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(secret, code, { timeMs: t0 }), true);
  assert.equal(verifyTotp(secret, '000000', { timeMs: t0 }), false);
});

test('时钟偏移容忍 ±1 步', () => {
  const secret = generateTotpSecret();
  const t0 = 1_700_000_000_000;
  const codeNow = totp(secret, t0);
  // 校验端时钟快/慢 30 秒（一个 step）仍应通过
  assert.equal(verifyTotp(secret, codeNow, { timeMs: t0 + 30_000, window: 1 }), true);
  assert.equal(verifyTotp(secret, codeNow, { timeMs: t0 - 30_000, window: 1 }), true);
  // 超出容忍窗口则失败
  assert.equal(verifyTotp(secret, codeNow, { timeMs: t0 + 90_000, window: 1 }), false);
  assert.equal(verifyTotp(secret, codeNow, { timeMs: t0 + 30_000, window: 0 }), false);
});

test('非数字验证码直接拒绝', () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotp(secret, 'abcdef'), false);
  assert.equal(verifyTotp(secret, ''), false);
});
