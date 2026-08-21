import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseCliArgs } from '../src/config.js';

test('connector 配置：默认值与校验', () => {
  const cfg = loadConfig({
    gatewayUrl: 'wss://gate.example.com/',
    connectorKey: 'k',
  });
  assert.equal(cfg.gatewayUrl, 'wss://gate.example.com', '尾部斜杠应去除');
  assert.equal(cfg.targetUrl, 'http://127.0.0.1:58627');
});

test('非 ws 协议的 GATEWAY_URL 被拒绝', () => {
  assert.throws(
    () => loadConfig({ gatewayUrl: 'https://gate.example.com', connectorKey: 'k' }),
    /ws:\/\/ 或 wss:\/\//,
  );
});

test('CLI 参数解析：长选项与短选项', () => {
  const a = parseCliArgs(['--gateway', 'wss://g.example.com', '--key', 'K', '--target', 'http://127.0.0.1:58628', '--check']);
  assert.equal(a.gatewayUrl, 'wss://g.example.com');
  assert.equal(a.connectorKey, 'K');
  assert.equal(a.targetUrl, 'http://127.0.0.1:58628');
  assert.equal(a.check, true);

  const b = parseCliArgs(['-g', 'wss://g2.example.com', '-k', 'K2']);
  assert.equal(b.gatewayUrl, 'wss://g2.example.com');
  assert.equal(b.connectorKey, 'K2');
  assert.equal(b.targetUrl, undefined);
});

test('CLI 参数解析：缺值与未知参数报错', () => {
  assert.throws(() => parseCliArgs(['--gateway']), /缺少值/);
  assert.throws(() => parseCliArgs(['--nope']), /未知参数/);
});

test('CLI 参数优先级高于 .env/环境变量', () => {
  const cfg = loadConfig(parseCliArgs(['--gateway', 'wss://cli.example.com', '--key', 'cli-key']));
  assert.equal(cfg.gatewayUrl, 'wss://cli.example.com');
  assert.equal(cfg.connectorKey, 'cli-key');
});
