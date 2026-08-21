import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { RateLimiter } from '../src/ratelimit.js';

function makeLimiter(now: () => number, limit = 10, windowMs = 60_000) {
  const db = openDb(':memory:');
  return { db, limiter: new RateLimiter(db, { limit, windowMs, now }) };
}

test('同一设备 1 分钟内第 11 次被拒绝', () => {
  let t = 1_000_000;
  const { db, limiter } = makeLimiter(() => t);
  for (let i = 1; i <= 10; i++) {
    assert.equal(limiter.allow('dev-A'), true, `第 ${i} 次应放行`);
  }
  assert.equal(limiter.allow('dev-A'), false, '第 11 次应拒绝');
  assert.equal(limiter.count('dev-A'), 11); // 超限的尝试也计入窗口
  db.close();
});

test('不同设备互不影响', () => {
  let t = 1_000_000;
  const { db, limiter } = makeLimiter(() => t);
  for (let i = 0; i < 10; i++) limiter.allow('dev-A');
  assert.equal(limiter.allow('dev-A'), false);
  assert.equal(limiter.allow('dev-B'), true, '另一设备不受 dev-A 限流影响');
  db.close();
});

test('窗口滑动后恢复放行', () => {
  let t = 1_000_000;
  const { db, limiter } = makeLimiter(() => t);
  for (let i = 0; i < 10; i++) limiter.allow('dev-A');
  assert.equal(limiter.allow('dev-A'), false);
  t += 61_000; // 滑出窗口
  assert.equal(limiter.allow('dev-A'), true, '窗口滑过后应恢复');
  db.close();
});

test('部分滑动：只有最旧的请求滑出窗口时才逐个恢复', () => {
  let t = 1_000_000;
  const { db, limiter } = makeLimiter(() => t);
  for (let i = 0; i < 10; i++) {
    limiter.allow('dev-A');
    t += 5_000; // 每 5 秒一次，共 50 秒
  }
  assert.equal(limiter.allow('dev-A'), false); // 第 11 次（也被计入窗口），t = 1_050_000
  t += 16_000; // t = 1_066_000：最旧两次 (1_000_000, 1_005_000) 滑出 60s 窗口，窗口内剩 9 次
  assert.equal(limiter.allow('dev-A'), true);
  assert.equal(limiter.allow('dev-A'), false, '只恢复了一个配额');
  db.close();
});
