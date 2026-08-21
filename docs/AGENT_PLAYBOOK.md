# kimi-gate 部署操作手册（给 AI Agent 读）

> 这份手册的读者是 **AI 编程助手**（Kimi Code、Claude Code、Cursor 等），不是人。
> 你的任务：全程引导用户完成 kimi-gate 的部署，从"什么都没有"到"用户能用手机浏览器登录自己的 Kimi Code"。
> 你负责给建议、生成配置、执行命令、排查问题；用户只需要做选择题和复制粘贴。
>
> **完成标准（Definition of Done）**：用户在手机浏览器打开 `https://<域名>`，输入密码，看到 Kimi Code Web 界面，并能发一条消息得到回复。

## 行为准则（先读这个）

1. **一次只推进一个阶段**，每个阶段结束告诉用户进展和下一步要ta做什么。不要一次性甩出所有步骤。
2. **涉及花钱、创建外部资源（买服务器、改 DNS）的步骤，给出具体建议但让用户自己点确认**——你无法替ta付款。
3. **所有密码/密钥用安全随机生成**（如 `openssl rand -base64 12` 或等效），不要自己想"好记的密码"。生成后明确交付给用户保存。
4. **绝不把 `.env`、私钥、密码提交进 git**，也不要在输出里无必要地回显完整密钥。
5. 长命令（构建、安装）放后台执行；Windows 上绝不弹出可见终端窗口打扰用户。
6. 遇到报错先看日志再动手，不要盲改。日志位置见文末排查表。
7. 这份手册来自一次真实部署的完整复盘。里面的"坑"都是真实踩过的，已被修复或写明规避方法——照着走可以绕开。

## 过程总览

| # | 阶段 | 在哪里操作 | 干什么 | 大约耗时 |
|---|---|---|---|---|
| 0 | 决策 | 与用户对话 | 确认路线（A/B）、云厂商、域名 | 5 分钟 |
| 1 | 买服务器 | 云厂商控制台（用户操作） | 轻量服务器 + Ubuntu 24.04 + 防火墙放行 | 10 分钟 |
| 2 | 域名解析 | DNSPod / 域名控制台（用户操作） | A 记录指向服务器 IP | 3 分钟 |
| 3 | 服务器装 Gateway | SSH 进服务器（你执行） | Node 24 → 拉代码 → pnpm 构建 → 初始化 → systemd | 10 分钟 |
| 4 | HTTPS 证书 | SSH 进服务器（你执行） | Caddy 反代 + 自动签证书 | 5 分钟 |
| 5 | 家里电脑装 Connector | 用户家用电脑（你执行） | 构建 → 配置 → 注册开机自启 | 10 分钟 |
| 6 | 电源策略 | 用户家用电脑（你执行） | 禁止睡眠、合盖不动作 | 1 分钟 |
| 7 | 验收 | 手机/任意浏览器 | 登录 → 进 Kimi Code → 发条消息 | 5 分钟 |
| 8 | 安全收尾 | SSH + 管理台 | 关 SSH 密码登录、改初始密码、（可选）开 TOTP | 5 分钟 |

合计约 1 小时，其中大部分是等待（证书签发、DNS 生效、构建）。

## 阶段 0：决策（问用户三个问题）

**Q1 路线**：kimi web 跑在哪？
- **路线 B（隧道，推荐）**：kimi web 在家里/办公室电脑，云服务器只做网关。家里零端口开放、不需要公网 IP。适用绝大多数个人用户。
- **路线 A（同机直连）**：把 Kimi Code CLI 也装在云服务器上，不需要家里电脑开机。适合"家里没有能一直开机的电脑"的用户。

**Q2 云厂商**：给出建议——
- 国内用户、域名已备案：**腾讯云轻量应用服务器** 或 阿里云轻量，2核2G 即可（约 ¥99/年档位），地域选离用户近的。
- 域名没备案：**必须告知**——国内服务器的 80/443 端口在域名完成备案接入前会被拦截。要么先备案（约 2–20 个工作日），要么选境外服务器（香港/新加坡，免备案但延迟高些）。
- 配置不用高：Gateway 是轻量代理，2C2G 绰绰有余；本次真实部署就是 2核2G4M。

**Q3 域名**：需要一个域名（几块钱/年的就行）并解析到服务器。HTTPS 必须有域名，纯 IP 不行。

## 阶段 1：购买与初始化服务器（用户操作，你指导）

引导用户在控制台完成：

1. **镜像选 Ubuntu 24.04**（裸系统，不要选应用镜像）。
2. **登录方式选 SSH 密钥**：让用户在本机生成（`ssh-keygen -t ed25519`）或直接用已有密钥，购买时绑定；比密码登录安全，也为阶段 8 关密码登录做准备。
3. **防火墙**：轻量服务器的防火墙在控制台单独配置（不是系统内 ufw）。放行三条：TCP 22（SSH）、TCP 80（HTTP，证书签发给 Let's Encrypt 验证用）、TCP 443（HTTPS）。真实部署中用户漏了 443，后来补上的——提醒一次到位。
4. 记下**公网 IP**，交给用户保存。

你拿到 IP 和密钥后先验证：`ssh -i <密钥> ubuntu@<IP> 'echo ok'`（Ubuntu 默认用户 `ubuntu`）。Windows 下私钥权限问题若报错，指引用户用 WSL/Git Bash 或调整 ACL。

建议给用户配一个 SSH 别名（`~/.ssh/config`），后续命令都简短。

## 阶段 2：域名解析（用户操作，你指导）

DNSPod（或用户的域名服务商）控制台 → 添加记录：

- 主机记录：一个子域名，如 `kimi`（最终 `kimi.example.com`）
- 记录类型：`A`
- 记录值：服务器公网 IP
- TTL 默认即可

验证：本机 `nslookup kimi.example.com` 返回服务器 IP 再继续。国内 DNS 通常几分钟生效。

## 阶段 3：服务器安装 Gateway（你 SSH 执行）

```bash
# 1. 基础环境
sudo apt update && sudo apt install -y git curl
# 2G 内存建议加 swap，避免构建时 OOM（真实部署中做过）
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 2. Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt install -y nodejs
sudo corepack enable   # 启用 pnpm

# 3. 拉代码（公开仓库直接 https；私有仓库用只读 deploy key）
git clone https://github.com/<owner>/kimi-gate.git
cd kimi-gate

# 4. 一键安装：pnpm install → build → 初始化向导 → systemd
sudo bash scripts/install.sh
```

初始化向导会要求：

- **管理员密码**：你用安全随机生成一个（≥12 位），交付用户保存。
- **kimi bearer token**：来自家里电脑的 kimi web。让用户（或你直接在家里电脑上）运行 `kimi web --port 58627`，启动输出里有 `Token: xxxx`，粘贴过来。此 token 只存服务器 `.env`，客户端永不接触。
- **路线选择**：按阶段 0 的决定。
- 向导输出的 **CONNECTOR_KEY**（路线 B）：保存好，阶段 5 要用。

`install.sh` 会装好 systemd 服务 `kimi-gate-gateway`（开机自启、崩溃自拉起）。验证：`systemctl is-active kimi-gate-gateway` 返回 `active`，`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login` 返回 200。

## 阶段 4：HTTPS（Caddy，你执行）

```bash
sudo apt install -y caddy
```

写 `/etc/caddy/Caddyfile`（仓库根目录有参考）：

```
kimi.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

`sudo systemctl reload caddy`，Caddy 自动向 Let's Encrypt 申请证书（需要 80 端口可达 + DNS 已生效，所以阶段 1、2 必须先完成）。

验证：`curl -sI https://kimi.example.com/login | head -1` 返回 `HTTP/2 200`，浏览器访问无证书警告。

## 阶段 5：家里电脑装 Connector（路线 B，你执行）

在用户家里/办公室那台**会一直开机**的电脑上：

```bash
git clone https://github.com/<owner>/kimi-gate.git
cd kimi-gate
corepack enable
pnpm install && pnpm run build
```

写 `packages/connector/.env`：

```env
GATEWAY_URL=wss://kimi.example.com
CONNECTOR_KEY=<阶段 3 向导输出的配对密钥>
KIMI_LOCAL_URL=http://127.0.0.1:58627
```

同时确保 kimi web 常驻：`kimi web --port 58627 --no-open`。

**常驻方案（Windows）**：用任务计划程序 + VBS 隐藏启动（仓库 `packages/connector/README.md` 有完整方法），真实部署注册了两个任务：`KimiGateWeb`（kimi web）和 `KimiGateConnector`。Linux/macOS 用 systemd user unit 或 pm2。日志重定向到文件（如 `%USERPROFILE%\.kimi-gate\logs\connector.log`），排查全靠它。

验证：日志出现 `已连接 gateway: wss://...`；管理台 `https://kimi.example.com/admin` 顶部显示"隧道： 在线"。

## 阶段 6：电源策略（Windows，你执行）

家里电脑睡眠 = 远程访问中断。真实部署中执行过：

```powershell
powercfg /change standby-timeout-ac 0        # 接通电源永不睡眠
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0   # 合盖不动作（笔记本）
powercfg /setactive SCHEME_CURRENT
```

提醒用户：电脑要插电源、屏幕可以关但机器不能睡。

## 阶段 7：验收（用户在手机/任意浏览器操作）

1. 手机浏览器（鸿蒙/任意）打开 `https://kimi.example.com` → 看到登录页。
2. 输入管理员密码 → 进入 Kimi Code Web 界面 → 随便发一条消息得到回复。
3. 打开 `https://kimi.example.com/admin`，输密码二次确认，能看到刚才的登录记录。

全部通过 = 部署完成，向用户交付：网址、管理员密码、管理台地址、SSH 别名、常用维护命令。

## 阶段 8：安全收尾（你执行 + 引导用户）

1. **关闭 SSH 密码登录**（确认密钥能登之后）：`/etc/ssh/sshd_config` 设 `PasswordAuthentication no`，`sudo systemctl reload ssh`。
2. **引导用户在管理台改掉初始密码**：改密成功即全部设备下线，这是止损入口。
3. （可选）**开 TOTP 双因素**：`.env` 配 `TOTP_SECRET`，用户验证器 App 扫码。
4. 告诉用户审计日志在哪看（管理台），建议偶尔翻翻有没有陌生 IP。

## 故障排查表（真实踩过的坑）

| 现象 | 真实原因 | 处理 |
|---|---|---|
| 登录页报"表单校验失败" | 旧版本 CSRF token 每次 GET 轮换，多标签页/浏览器扩展会把表单 token 作废（v0.1 已修复） | 确认部署的是最新代码；刷新页面重输密码 |
| 页面显示"Connector 离线" | 家里电脑 connector 没跑/断网/睡眠了 | 看 connector 日志；确认计划任务在运行；检查阶段 6 电源策略 |
| 手机能开登录页但登录后一直转圈 | 隧道没连上或 kimi web 没在跑 | 管理台看隧道状态；家里电脑确认 `kimi web` 存活 |
| Caddy 签证书失败 | DNS 未生效 / 80 端口没放行 / 域名未备案接入被拦截 | `nslookup` 验证；查控制台防火墙；国内机器先确认备案 |
| `ssh` 登不上 | 私钥权限太开放（Windows）/ 买服务器时没绑密钥 | 控制台 VNC 登录补救，或重置密钥 |
| Gateway 日志、审计 | `journalctl -u kimi-gate-gateway -n 50` | 先看日志再动手 |
| Connector 日志 | 家里电脑上的日志文件（阶段 5 配置的路径） | 断线重连是自动的，持续离线必有日志线索 |

## 交付清单模板（部署完成后发给用户）

```
✅ kimi-gate 部署完成
· 访问地址:  https://<域名>
· 管理台:    https://<域名>/admin
· 管理员密码: <密码>（请立即在管理台修改为自己的密码）
· 服务器:    <厂商> <IP>（SSH 别名: <别名>）
· 常用命令:
  - 看 Gateway 日志:  ssh <别名> 'journalctl -u kimi-gate-gateway -f'
  - 重启 Gateway:     ssh <别名> 'sudo systemctl restart kimi-gate-gateway'
  - 更新版本:         ssh <别名> 'cd ~/kimi-gate && git pull && pnpm install --frozen-lockfile && pnpm run build && sudo systemctl restart kimi-gate-gateway'
· 注意: 家里电脑需保持开机不睡眠；Connector 断线会自动重连。
```
