# Настройка Xray-ноды для 4StepsVPN

## Минимальный inbound (VLESS + Reality)

```json
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "tag": "vless-reality",
      "listen": "0.0.0.0",
      "port": 443,
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
          "dest": "www.cloudflare.com:443",
          "xver": 0,
          "serverNames": ["www.cloudflare.com"],
          "privateKey": "YOUR_PRIVATE_KEY",
          "shortIds": ["", "YOUR_SHORT_ID"]
        }
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["http", "tls", "quic"]
      }
    },
    {
      "tag": "api",
      "listen": "0.0.0.0",
      "port": 10085,
      "protocol": "dokodemo-door",
      "settings": { "address": "127.0.0.1" }
    }
  ],
  "outbounds": [{ "protocol": "freedom", "tag": "direct" }],
  "api": {
    "tag": "api",
    "services": ["HandlerService", "StatsService"]
  },
  "routing": {
    "rules": [
      {
        "inboundTag": ["api"],
        "outboundTag": "api"
      }
    ]
  },
  "policy": {
    "levels": {
      "0": { "statsUserUplink": true, "statsUserDownlink": true }
    },
    "system": {
      "statsInboundUplink": true,
      "statsInboundDownlink": true
    }
  },
  "stats": {}
}
```

## Ключи Reality

```bash
xray x25519
openssl rand -hex 4
```

## Безопасность API

Порт `10085` лучше слушать только с IP backend или через VPN между серверами.

В админке:

```
name|host|port|type|publicKey|shortId|sni
```
