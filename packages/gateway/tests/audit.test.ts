import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { recordAttempt, queryAttempts, attemptsToCsv } from '../src/audit.js';

test('登录审计写入与查询', () => {
  const db = openDb(':memory:');
  recordAttempt(db, { ip: '1.2.3.4', ua: 'UA-1', device: 'd1', result: 'success' });
  recordAttempt(db, { ip: '1.2.3.4', ua: 'UA-1', device: 'd1', result: 'bad_password', reason: 'wrong password' });
  recordAttempt(db, { ip: '5.6.7.8', ua: 'UA-2, with comma', device: 'd2', result: 'rate_limited', reason: 'too many' });

  const all = queryAttempts(db);
  assert.equal(all.length, 3);
  assert.ok(all[0].ts >= all[2].ts, '按时间倒序');
  assert.equal(all[0].id > 0, true);

  const badOnly = queryAttempts(db, { result: 'bad_password' });
  assert.equal(badOnly.length, 1);
  assert.equal(badOnly[0].reason, 'wrong password');

  const ipOnly = queryAttempts(db, { ip: '5.6.7.8' });
  assert.equal(ipOnly.length, 1);
  assert.equal(ipOnly[0].result, 'rate_limited');

  const ranged = queryAttempts(db, { from: Date.now() + 1000 });
  assert.equal(ranged.length, 0);
  db.close();
});

test('CSV 导出含表头且正确转义', () => {
  const db = openDb(':memory:');
  recordAttempt(db, { ip: '1.2.3.4', ua: 'UA, "quoted"', device: 'd1', result: 'success' });
  const rows = queryAttempts(db);
  const csv = attemptsToCsv(rows);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('id,ts,iso_time,ip,user_agent,device,result,reason'));
  assert.ok(lines[1].includes('"UA, ""quoted"""'), '逗号与引号应转义');
  db.close();
});
