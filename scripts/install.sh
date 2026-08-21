#!/usr/bin/env bash
# kimi-gate 裸机一键部署（Linux 云服务器）
# 用法: sudo bash scripts/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="kimi-gate-gateway"
RUN_USER="${SUDO_USER:-$(whoami)}"

echo "==> 安装目录: $APP_DIR"
echo "==> 运行用户: $RUN_USER"

# ---------- 1. 检查 Node >= 22.5（推荐 24，node:sqlite 免 flag） ----------
if ! command -v node >/dev/null 2>&1; then
  echo "!! 未找到 node。请先安装 Node.js 24+，例如:"
  echo "   curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs"
  exit 1
fi
NODE_VER="$(node -e 'const [a,b]=process.versions.node.split(".").map(Number); console.log(a*100+b)')"
if [ "$NODE_VER" -lt 2205 ]; then
  echo "!! Node 版本过低: $(node -v)。需要 >= 22.5（node:sqlite），推荐 Node 24。"
  exit 1
fi
echo "==> Node $(node -v) OK"

# ---------- 2. 依赖与构建 ----------
cd "$APP_DIR"
echo "==> npm ci"
sudo -u "$RUN_USER" npm ci --no-audit --no-fund
echo "==> npm run build"
sudo -u "$RUN_USER" npm run build

# ---------- 3. 初始化配置 ----------
if [ ! -f "$APP_DIR/.env" ]; then
  echo "==> 首次部署，启动交互式初始化向导…"
  sudo -u "$RUN_USER" npm run setup
else
  echo "==> 已存在 .env，跳过初始化"
fi

# ---------- 4. systemd unit ----------
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
echo "==> 写入 $UNIT_FILE"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=kimi-gate gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/packages/gateway/dist/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=GATEWAY_CONFIG=${APP_DIR}/.env
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
echo
echo "==> 完成。常用命令:"
echo "    systemctl status $SERVICE_NAME"
echo "    journalctl -u $SERVICE_NAME -f"
echo
echo "提示: 本服务监听 HTTP，请在前面配置 TLS 反代（如 Caddy，参考仓库 Caddyfile），"
echo "      然后在家里 PC 上运行 connector 指向 wss://<你的域名>。"
