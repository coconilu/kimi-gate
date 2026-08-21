import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, activeAlgorithm } from '../src/password.js';

test('hash/verify 往返', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(hash.startsWith('argon2id$') || hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('两次哈希结果不同（随机盐）', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('scrypt 格式的存量哈希仍可校验（回退路径）', async () => {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync('hunter2hunter2', salt, 32, { N: 16384, r: 8, p: 1 });
  const stored = `scrypt$16384,8,1$${salt.toString('base64')}$${derived.toString('base64')}`;
  assert.equal(await verifyPassword('hunter2hunter2', stored), true);
  assert.equal(await verifyPassword('hunter3', stored), false);
});

test('畸形哈希不抛异常，返回 false', async () => {
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'bcrypt$1,2,3$aa$bb'), false);
});

test('能力检测：Node 24 应使用 argon2id', () => {
  if (typeof (crypto as unknown as { argon2?: unknown }).argon2 === 'function') {
    assert.equal(activeAlgorithm(), 'argon2id');
  } else {
    assert.equal(activeAlgorithm(), 'scrypt');
  }
});
