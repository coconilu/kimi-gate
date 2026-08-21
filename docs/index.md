# kimi-gate

**自托管安全网关：出门在外，用手机浏览器远程访问家里电脑上的 Kimi Code CLI `kimi web`。**

[![npm](https://img.shields.io/npm/v/kimi-gate-connector?label=kimi-gate-connector)](https://www.npmjs.com/package/kimi-gate-connector)
[![ci](https://github.com/coconilu/kimi-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/coconilu/kimi-gate/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/coconilu/kimi-gate/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/repo-coconilu%2Fkimi--gate-181717?logo=github)](https://github.com/coconilu/kimi-gate)

## 30 秒看完它是什么

手机浏览器打开自己的域名，输密码，就能远程使用家里电脑上的 Kimi Code：

<img src="images/login-mobile.jpg" alt="登录页（手机视图）" width="260"> <img src="images/app-mobile.jpg" alt="手机上使用 kimi web" width="260">

家里电脑只需一行命令接入（无需克隆仓库，自带连通性自检）：

![connector 自检通过并打印访问地址](images/connector-terminal.jpg)

自带管理台：接入命令一键复制、修改密码、活跃会话管理、登录日志与 IP 封禁：

![Connector 接入](images/admin-connector.jpg)
![登录日志与 IP 封禁](images/admin-logs.jpg)

## 快速开始（把这段话发给你的 AI 助手）

不用看文档，也不用懂部署——把下面这段话发给 Kimi Code / Claude Code / Cursor 等任意 AI 编程助手，它会全程引导你完成（选服务器、生成密码、配域名解析，直到手机能登录）：

> 请阅读 https://github.com/coconilu/kimi-gate/blob/main/docs/AGENT_PLAYBOOK.md ，然后全程引导我完成 kimi-gate 的部署。我手上有一台会一直开机的电脑（装着 Kimi Code CLI），其他都还没有。请一步一步来，每个阶段告诉我该做什么。

## 为什么安全

- **kimi bearer token 不出服务器**：只存在你自己的 VPS 上，代理时注入请求头，手机端永不接触
- **家里网络零端口开放**：Connector 只建立出站长连接，NAT/防火墙不用动
- **登录有审计和限流**：设备指纹 10 次/分钟滑动窗口限流，所有登录尝试落库可查，管理台可踢会话、封 IP
- **全程 TLS**：Caddy 自动签 Let's Encrypt 证书

## 了解更多

- [GitHub 仓库与完整 README](https://github.com/coconilu/kimi-gate)
- [用户指南（15 分钟上手，非技术向）](USER_GUIDE.md)
- [部署操作手册（给 AI 助手看的）](AGENT_PLAYBOOK.md)
- [问题反馈 / 功能建议](https://github.com/coconilu/kimi-gate/issues)
