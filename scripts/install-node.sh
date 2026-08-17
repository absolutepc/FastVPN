#!/usr/bin/env bash
set -Eeuo pipefail

# 4StepsVPN node installer
# Target: Ubuntu 24.04+, Xray VLESS + REALITY

XRAY_BIN="/usr/local/bin/xray"
XRAY_CONFIG="/usr/local/etc/xray/config.json"
METRICS_BIN="/usr/local/bin/4steps-node-metrics"
NODE_INFO="/root/4steps-node-info.json"

VLESS_PORT="${VLESS_PORT:-443}"
XRAY_API_PORT="${XRAY_API_PORT:-10085}"
INBOUND_TAG="${INBOUND_TAG:-vless-reality}"
REALITY_SERVER_NAME="${REALITY_SERVER_NAME:-www.cloudflare.com}"
REALITY_TARGET="${REALITY_TARGET:-www.cloudflare.com:443}"

BACKEND_IP="91.132.57.6"
BACKEND_SSH_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFxm+KpLPOujpLanr0LOE03+ljaIEa9pd5pQ2241b9KS'
REGISTER_URL="https://4stepsvpn.ru/node-register"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run as root"

# Never install a VPN node over the 4StepsVPN backend.
if ip -4 addr show | grep -q "${BACKEND_IP//./\\.}"; then
  die "this is the 4StepsVPN backend VPS; node installation is blocked"
fi

if [[ -d "/opt/FastVPN" && -f "/opt/FastVPN/package.json" ]]; then
  die "FastVPN backend detected; refusing to install a VPN node here"
fi

[[ -r /etc/os-release ]] || die "cannot detect operating system"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "Ubuntu is required"

echo "=========================================="
echo "  4StepsVPN Node Installer"
echo "=========================================="
echo "OS: ${PRETTY_NAME:-Ubuntu}"
echo "VLESS: 0.0.0.0:${VLESS_PORT}"
echo "Xray API: 127.0.0.1:${XRAY_API_PORT}"
echo "REALITY target: ${REALITY_TARGET}"
echo

echo "[1/8] Installing dependencies"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl \
  unzip \
  openssl \
  ca-certificates \
  python3 \
  iproute2

echo "[2/8] Installing Xray"
bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install

[[ -x "${XRAY_BIN}" ]] || die "Xray installation failed"

echo "[3/8] Generating REALITY credentials"
KEYPAIR="$("${XRAY_BIN}" x25519)"

PRIVATE_KEY="$(
  printf '%s\n' "${KEYPAIR}" |
  awk -F': ' '
    /Private key:/ {print $2; exit}
    /^PrivateKey:/ {print $2; exit}
  '
)"

PUBLIC_KEY="$(
  printf '%s\n' "${KEYPAIR}" |
  awk -F': ' '
    /Public key:/ {print $2; exit}
    /^PublicKey:/ {print $2; exit}
    /^Password \(PublicKey\):/ {print $2; exit}
    /^Password:/ {print $2; exit}
  '
)"

[[ -n "${PRIVATE_KEY}" ]] || {
  echo "${KEYPAIR}"
  die "failed to parse REALITY private key"
}

[[ -n "${PUBLIC_KEY}" ]] || {
  echo "${KEYPAIR}"
  die "failed to parse REALITY public key"
}

SHORT_ID="$(openssl rand -hex 4)"

echo "[4/8] Creating Xray configuration"
mkdir -p "$(dirname "${XRAY_CONFIG}")"

cat > "${XRAY_CONFIG}" <<EOF
{
  "log": {
    "loglevel": "warning"
  },
  "inbounds": [
    {
      "tag": "${INBOUND_TAG}",
      "listen": "0.0.0.0",
      "port": ${VLESS_PORT},
      "protocol": "vless",
      "settings": {
        "clients": [],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "xver": 0,
          "serverNames": [
            "${REALITY_SERVER_NAME}"
          ],
          "privateKey": "${PRIVATE_KEY}",
          "shortIds": [
            "${SHORT_ID}"
          ],
          "target": "${REALITY_TARGET}"
        }
      },
      "sniffing": {
        "enabled": true,
        "destOverride": [
          "http",
          "tls",
          "quic"
        ]
      }
    }
  ],
  "outbounds": [
    {
      "protocol": "freedom",
      "tag": "direct"
    }
  ],
  "api": {
    "tag": "api",
    "listen": "127.0.0.1:${XRAY_API_PORT}",
    "services": [
      "HandlerService",
      "StatsService"
    ]
  },
  "stats": {},
  "policy": {
    "levels": {
      "0": {
        "statsUserUplink": true,
        "statsUserDownlink": true
      }
    },
    "system": {
      "statsInboundUplink": true,
      "statsInboundDownlink": true
    }
  }
}
EOF

echo "[5/8] Testing Xray configuration"
"${XRAY_BIN}" run -test -config "${XRAY_CONFIG}"

echo "[6/8] Starting Xray"
systemctl daemon-reload
systemctl enable xray >/dev/null
systemctl restart xray
sleep 2

systemctl is-active --quiet xray || {
  systemctl status xray --no-pager || true
  die "Xray failed to start"
}

echo "[7/8] Installing metrics helper"
cat > "${METRICS_BIN}" <<'METRICS'
#!/usr/bin/env bash
set -euo pipefail

CPU="$(
python3 - <<'PYCPU'
import time

def read_cpu():
    with open('/proc/stat') as f:
        values = list(map(int, f.readline().split()[1:]))

    idle = values[3] + values[4]
    total = sum(values)
    return idle, total

idle1, total1 = read_cpu()
time.sleep(1)
idle2, total2 = read_cpu()

idle_delta = idle2 - idle1
total_delta = total2 - total1

if total_delta <= 0:
    cpu = 0.0
else:
    cpu = 100.0 * (1.0 - idle_delta / total_delta)

print(f"{cpu:.1f}")
PYCPU
)"

RAM_TOTAL="$(free -m | awk '/Mem:/ {print $2}')"
RAM_USED="$(free -m | awk '/Mem:/ {print $3}')"
RAM_PCT="$(awk -v used="${RAM_USED}" -v total="${RAM_TOTAL}" 'BEGIN {printf "%.1f", (used/total)*100}')"

DISK_USED="$(df -h / | awk 'NR==2 {print $3}')"
DISK_TOTAL="$(df -h / | awk 'NR==2 {print $2}')"
DISK_PCT="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"

LOAD_1M="$(awk '{print $1}' /proc/loadavg)"
UPTIME="$(uptime -p | sed 's/^up //')"

if systemctl is-active --quiet xray; then
  XRAY="active"
else
  XRAY="inactive"
fi

if ss -lnt | awk '{print $4}' | grep -Eq '(^|:|\])443$'; then
  PORT_443="open"
else
  PORT_443="closed"
fi

CONNECTIONS_443="$(
  ss -Htn state established 2>/dev/null |
  awk '$4 ~ /:443$/ {count++} END {print count+0}'
)"

IFACE="$(ip route show default 2>/dev/null | awk 'NR==1 {print $5}')"

if [[ -n "${IFACE:-}" && -r "/sys/class/net/${IFACE}/statistics/rx_bytes" ]]; then
  RX_BYTES="$(cat "/sys/class/net/${IFACE}/statistics/rx_bytes")"
  TX_BYTES="$(cat "/sys/class/net/${IFACE}/statistics/tx_bytes")"
else
  RX_BYTES=0
  TX_BYTES=0
fi

python3 - <<PY
import json

print(json.dumps({
    "cpu_percent": float("${CPU}"),
    "ram": {
        "used_mb": int("${RAM_USED}"),
        "total_mb": int("${RAM_TOTAL}"),
        "percent": float("${RAM_PCT}")
    },
    "disk": {
        "used": "${DISK_USED}",
        "total": "${DISK_TOTAL}",
        "percent": int("${DISK_PCT}")
    },
    "load_1m": float("${LOAD_1M}"),
    "uptime": "${UPTIME}",
    "xray": "${XRAY}",
    "port_443": "${PORT_443}",
    "connections_443": int("${CONNECTIONS_443}"),
    "network": {
        "rx_bytes": int("${RX_BYTES}"),
        "tx_bytes": int("${TX_BYTES}")
    }
}, indent=2))
PY
METRICS

chmod 755 "${METRICS_BIN}"

echo "[8/9] Authorizing 4StepsVPN backend tunnel"

mkdir -p /root/.ssh
chmod 700 /root/.ssh

touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

AUTHORIZED_LINE="restrict,port-forwarding,permitopen=\"127.0.0.1:${XRAY_API_PORT}\" ${BACKEND_SSH_KEY}"

if ! grep -Fq "${BACKEND_SSH_KEY}" /root/.ssh/authorized_keys; then
  echo "${AUTHORIZED_LINE}" >> /root/.ssh/authorized_keys
fi

echo "[9/9] Running health checks"
XRAY_STATUS="$(systemctl is-active xray || true)"

if ss -lnt | grep -qE "[:.]${VLESS_PORT}[[:space:]]"; then
  PORT_STATUS="open"
else
  PORT_STATUS="closed"
fi

if ss -lnt | grep -q "127.0.0.1:${XRAY_API_PORT}"; then
  API_STATUS="open"
else
  API_STATUS="closed"
fi

PUBLIC_IP="$(
  ip -4 route get 1.1.1.1 2>/dev/null |
  awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
)"

cat > "${NODE_INFO}" <<EOF
{
  "publicIp": "${PUBLIC_IP:-UNKNOWN}",
  "port": ${VLESS_PORT},
  "inboundTag": "${INBOUND_TAG}",
  "flow": "xtls-rprx-vision",
  "security": "reality",
  "network": "tcp",
  "serverName": "${REALITY_SERVER_NAME}",
  "publicKey": "${PUBLIC_KEY}",
  "shortId": "${SHORT_ID}",
  "apiHost": "127.0.0.1",
  "apiPort": ${XRAY_API_PORT}
}
EOF

chmod 600 "${NODE_INFO}"

echo
echo "[AUTO] Registering node in 4StepsVPN backend"

if [[ -z "${NODE_REGISTER_TOKEN:-}" ]]; then
  read -rsp "4StepsVPN register token: " NODE_REGISTER_TOKEN
  echo
fi

NODE_NAME="${NODE_NAME:-$(hostname)}"
NODE_TYPE="${NODE_TYPE:-STANDARD}"
NODE_MAX_USERS="${NODE_MAX_USERS:-50}"

REGISTER_PAYLOAD="$(python3 - <<PY
import json

print(json.dumps({
    "name": "${NODE_NAME}",
    "host": "${PUBLIC_IP}",
    "type": "${NODE_TYPE}",
    "port": ${VLESS_PORT},
    "maxUsers": ${NODE_MAX_USERS},
    "publicKey": "${PUBLIC_KEY}",
    "shortId": "${SHORT_ID}",
    "sni": "${REALITY_SERVER_NAME}",
    "inboundTag": "${INBOUND_TAG}",
    "fingerprint": "chrome"
}))
PY
)"

REGISTER_RESPONSE="$(
  curl -fsS \
    -X POST \
    "${REGISTER_URL}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${NODE_REGISTER_TOKEN}" \
    --data "${REGISTER_PAYLOAD}"
)" || {
  echo "ERROR: backend registration failed"
  exit 1
}

echo "Backend response:"
echo "${REGISTER_RESPONSE}"

unset NODE_REGISTER_TOKEN

echo
echo "=========================================="
echo "  4StepsVPN NODE READY"
echo "=========================================="
echo "Public IP:       ${PUBLIC_IP:-UNKNOWN}"
echo "VLESS port:      ${VLESS_PORT}"
echo "Inbound tag:     ${INBOUND_TAG}"
echo "Flow:            xtls-rprx-vision"
echo "Security:        reality"
echo "Network:         tcp"
echo "Server name:     ${REALITY_SERVER_NAME}"
echo "Public key:      ${PUBLIC_KEY}"
echo "Short ID:        ${SHORT_ID}"
echo "Xray:            ${XRAY_STATUS}"
echo "Port ${VLESS_PORT}:         ${PORT_STATUS}"
echo "Xray API:        ${API_STATUS}"
echo "API address:     127.0.0.1:${XRAY_API_PORT}"
echo
echo "Node info saved to ${NODE_INFO}"
echo
"${METRICS_BIN}"
echo "=========================================="
