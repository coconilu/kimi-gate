import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

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
