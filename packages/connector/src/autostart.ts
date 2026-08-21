/**
 * 开机自启管理：--autostart 注册 / --no-autostart 移除。
 *
 * 纯函数 buildEnablePlan / buildDisablePlan 只描述"要写哪些文件、跑哪些命令"，
 * 不做任何 IO，方便跨平台测试；applyPlan 负责真正落地。
 *
 * 平台策略：
 *  - Windows：计划任务（登录时触发 wscript 静默运行 VBS → npx connector）
 *  - Linux：systemd --user 服务（enable --now；summary 提示 loginctl enable-linger）
 *  - macOS：launchd LaunchAgent（launchctl load -w）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ConnectorConfig } from './config.js';

export const TASK_NAME = 'KimiGateConnector';

export interface AutostartPlan {
  /** 给人看的说明（含命令、日志位置、如何撤销） */
  summary: string;
  /** 要写入的文件（覆盖写） */
  files: Array<{ path: string; content: string }>;
  /** 要执行的命令（execFile 形式，避免 shell 注入） */
  commands: string[][];
}

type Platform = NodeJS.Platform;

/** 目标平台的路径拼接（与运行测试/构建的宿主无关，保证输出确定） */
function joinFor(platform: Platform, ...segs: string[]): string {
  return (platform === 'win32' ? path.win32 : path.posix).join(...segs);
}

function connectorArgs(cfg: ConnectorConfig): string[] {
  const args = ['kimi-gate-connector', '--gateway', cfg.gatewayUrl, '--key', cfg.connectorKey];
  if (cfg.targetUrl !== 'http://127.0.0.1:58627') args.push('--target', cfg.targetUrl);
  return args;
}

function buildWindowsEnable(cfg: ConnectorConfig, home: string): AutostartPlan {
  const dir = joinFor('win32', home, '.kimi-gate');
  const vbs = joinFor('win32', dir, 'run-connector.vbs');
  const logFile = joinFor('win32', dir, 'connector.log');
  // VBS：隐藏窗口跑 npx，输出追加到日志
  const cmdLine = `cmd /c npx ${connectorArgs(cfg).join(' ')} >> "${logFile}" 2>&1`;
  const vbsContent = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "${cmdLine.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n');
  const createCmd = ['schtasks', '/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON',
    '/TR', `wscript.exe "${vbs}"`, '/F'];
  return {
    files: [{ path: vbs, content: vbsContent }],
    commands: [createCmd],
    summary: [
      `已注册 Windows 计划任务 "${TASK_NAME}"（用户登录时自动启动 Connector，隐藏窗口运行）。`,
      `  启动脚本: ${vbs}`,
      `  运行日志: ${logFile}`,
      `  撤销自启: npx kimi-gate-connector --no-autostart`,
    ].join('\n'),
  };
}

function buildWindowsDisable(home: string): AutostartPlan {
  const dir = joinFor('win32', home, '.kimi-gate');
  return {
    files: [],
    commands: [['schtasks', '/Delete', '/TN', TASK_NAME, '/F']],
    summary: [
      `已移除 Windows 计划任务 "${TASK_NAME}"。`,
      `  启动脚本 ${joinFor('win32', dir, 'run-connector.vbs')} 未删除（含日志），不需要可手动删掉 ${dir}`,
    ].join('\n'),
  };
}

function buildLinuxEnable(cfg: ConnectorConfig, home: string): AutostartPlan {
  const dir = joinFor('linux', home, '.config', 'systemd', 'user');
  const unit = joinFor('linux', dir, 'kimi-gate-connector.service');
  const content = [
    '[Unit]',
    'Description=kimi-gate connector',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=/usr/bin/env npx ${connectorArgs(cfg).join(' ')}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  return {
    files: [{ path: unit, content }],
    commands: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'kimi-gate-connector.service'],
    ],
    summary: [
      '已注册并启动 systemd 用户服务 kimi-gate-connector.service。',
      `  单元文件: ${unit}`,
      '  查看日志: journalctl --user -u kimi-gate-connector -f',
      '  未登录也要常驻请执行: loginctl enable-linger $USER',
      '  撤销自启: npx kimi-gate-connector --no-autostart',
    ].join('\n'),
  };
}

function buildLinuxDisable(home: string): AutostartPlan {
  const unit = joinFor('linux', home, '.config', 'systemd', 'user', 'kimi-gate-connector.service');
  return {
    files: [],
    commands: [
      ['systemctl', '--user', 'disable', '--now', 'kimi-gate-connector.service'],
    ],
    summary: `已停用并移除 systemd 用户服务（单元文件 ${unit} 随之删除）。`,
  };
}

function buildMacEnable(cfg: ConnectorConfig, home: string): AutostartPlan {
  const plist = joinFor('darwin', home, 'Library', 'LaunchAgents', 'com.kimi-gate.connector.plist');
  const logFile = joinFor('darwin', home, 'Library', 'Logs', 'kimi-gate-connector.log');
  const args = ['/usr/bin/env', 'npx', ...connectorArgs(cfg)]
    .map((a) => `    <string>${a}</string>`).join('\n');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kimi-gate.connector</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`;
  return {
    files: [{ path: plist, content }],
    commands: [['launchctl', 'load', '-w', plist]],
    summary: [
      '已注册 launchd 任务 com.kimi-gate.connector（登录时自动启动，退出自动拉起）。',
      `  plist: ${plist}`,
      `  日志: ${logFile}`,
      '  撤销自启: npx kimi-gate-connector --no-autostart',
    ].join('\n'),
  };
}

function buildMacDisable(home: string): AutostartPlan {
  const plist = joinFor('darwin', home, 'Library', 'LaunchAgents', 'com.kimi-gate.connector.plist');
  return {
    files: [],
    commands: [['launchctl', 'unload', '-w', plist]],
    summary: `已移除 launchd 任务（plist ${plist} 随之删除）。`,
  };
}

export function buildEnablePlan(
  cfg: ConnectorConfig,
  platform: Platform = process.platform,
  home: string = os.homedir(),
): AutostartPlan {
  if (platform === 'win32') return buildWindowsEnable(cfg, home);
  if (platform === 'darwin') return buildMacEnable(cfg, home);
  return buildLinuxEnable(cfg, home);
}

export function buildDisablePlan(
  platform: Platform = process.platform,
  home: string = os.homedir(),
): AutostartPlan {
  if (platform === 'win32') return buildWindowsDisable(home);
  if (platform === 'darwin') return buildMacDisable(home);
  return buildLinuxDisable(home);
}

/** 落地执行：写文件 → 跑命令 → 清理（disable 时删除已知文件）。返回警告列表。 */
export function applyPlan(
  plan: AutostartPlan,
  opts: { removeFiles?: string[]; ignoreCommandErrors?: boolean } = {},
): string[] {
  const warnings: string[] = [];
  for (const f of plan.files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content);
  }
  for (const [cmd, ...args] of plan.commands) {
    try {
      execFileSync(cmd, args, { stdio: 'pipe' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.ignoreCommandErrors) {
        warnings.push(`执行 ${cmd} 未成功（可能本来就不存在）：${msg.split('\n')[0]}`);
      } else {
        throw new Error(`执行 ${cmd} 失败：${msg}`);
      }
    }
  }
  for (const f of opts.removeFiles ?? []) {
    try { fs.unlinkSync(f); } catch { /* 不存在就算了 */ }
  }
  return warnings;
}

/** disable 时需要顺带删除的文件路径（service unit / plist 由平台决定）。 */
export function disableLeftoverFiles(platform: Platform, home: string): string[] {
  if (platform === 'win32') return [];
  if (platform === 'darwin') {
    return [joinFor('darwin', home, 'Library', 'LaunchAgents', 'com.kimi-gate.connector.plist')];
  }
  return [joinFor('linux', home, '.config', 'systemd', 'user', 'kimi-gate-connector.service')];
}
