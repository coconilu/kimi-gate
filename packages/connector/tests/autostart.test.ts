import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnablePlan,
  buildDisablePlan,
  disableLeftoverFiles,
  TASK_NAME,
} from '../src/autostart.js';
import type { ConnectorConfig } from '../src/config.js';

const cfg: ConnectorConfig = {
  gatewayUrl: 'wss://kimi.example.com',
  connectorKey: 'abc123',
  targetUrl: 'http://127.0.0.1:58627',
  log: () => {},
};

const HOME = '/home/tester';
const WIN_HOME = 'C:\\Users\\tester';

test('Windows enable：写 VBS + schtasks 创建登录任务', () => {
  const plan = buildEnablePlan(cfg, 'win32', WIN_HOME);
  assert.equal(plan.files.length, 1);
  assert.ok(plan.files[0].path.endsWith('run-connector.vbs'));
  assert.ok(plan.files[0].content.includes('npx kimi-gate-connector'));
  assert.ok(plan.files[0].content.includes('--gateway wss://kimi.example.com'));
  assert.ok(plan.files[0].content.includes('--key abc123'));
  assert.equal(plan.commands.length, 1);
  const cmd = plan.commands[0];
  assert.equal(cmd[0], 'schtasks');
  assert.ok(cmd.includes('/Create'));
  assert.ok(cmd.includes(TASK_NAME));
  assert.ok(cmd.includes('ONLOGON'));
  assert.ok(plan.summary.includes(TASK_NAME));
});

test('Windows disable：schtasks 删除任务', () => {
  const plan = buildDisablePlan('win32', WIN_HOME);
  const cmd = plan.commands[0];
  assert.equal(cmd[0], 'schtasks');
  assert.ok(cmd.includes('/Delete'));
  assert.ok(cmd.includes(TASK_NAME));
  // Windows 保留 .kimi-gate 目录（含日志）
  assert.deepEqual(disableLeftoverFiles('win32', WIN_HOME), []);
});

test('Linux enable：systemd 用户服务，含 Restart 与 default.target', () => {
  const plan = buildEnablePlan(cfg, 'linux', HOME);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].path, '/home/tester/.config/systemd/user/kimi-gate-connector.service');
  const unit = plan.files[0].content;
  assert.ok(unit.includes('ExecStart=/usr/bin/env npx kimi-gate-connector --gateway wss://kimi.example.com --key abc123'));
  assert.ok(unit.includes('Restart=always'));
  assert.ok(unit.includes('WantedBy=default.target'));
  assert.deepEqual(plan.commands, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'kimi-gate-connector.service'],
  ]);
  assert.ok(plan.summary.includes('loginctl enable-linger'));
});

test('Linux disable：停用服务并删除 unit 文件', () => {
  const plan = buildDisablePlan('linux', HOME);
  assert.deepEqual(plan.commands, [
    ['systemctl', '--user', 'disable', '--now', 'kimi-gate-connector.service'],
  ]);
  assert.deepEqual(disableLeftoverFiles('linux', HOME), [
    '/home/tester/.config/systemd/user/kimi-gate-connector.service',
  ]);
});

test('macOS enable：LaunchAgent plist + launchctl load', () => {
  const plan = buildEnablePlan(cfg, 'darwin', HOME);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].path, '/home/tester/Library/LaunchAgents/com.kimi-gate.connector.plist');
  const plist = plan.files[0].content;
  assert.ok(plist.includes('<string>/usr/bin/env</string>'));
  assert.ok(plist.includes('<string>npx</string>'));
  assert.ok(plist.includes('<string>wss://kimi.example.com</string>'));
  assert.ok(plist.includes('<key>RunAtLoad</key><true/>'));
  assert.deepEqual(plan.commands, [
    ['launchctl', 'load', '-w', '/home/tester/Library/LaunchAgents/com.kimi-gate.connector.plist'],
  ]);
});

test('macOS disable：launchctl unload + 删除 plist', () => {
  const plan = buildDisablePlan('darwin', HOME);
  assert.deepEqual(plan.commands, [
    ['launchctl', 'unload', '-w', '/home/tester/Library/LaunchAgents/com.kimi-gate.connector.plist'],
  ]);
  assert.deepEqual(disableLeftoverFiles('darwin', HOME), [
    '/home/tester/Library/LaunchAgents/com.kimi-gate.connector.plist',
  ]);
});

test('非默认 target 时启动命令带上 --target', () => {
  const custom: ConnectorConfig = { ...cfg, targetUrl: 'http://127.0.0.1:9999' };
  const plan = buildEnablePlan(custom, 'linux', HOME);
  assert.ok(plan.files[0].content.includes('--target http://127.0.0.1:9999'));
  const defaultPlan = buildEnablePlan(cfg, 'linux', HOME);
  assert.ok(!defaultPlan.files[0].content.includes('--target'), '默认 target 不应冗余出现');
});
