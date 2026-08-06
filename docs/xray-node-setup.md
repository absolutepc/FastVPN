# Настройка Xray-ноды для Access One

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
# Private key → на сервер
# Public key  → в админку при добавлении ноды (pbk)
```

Short ID (8 hex):

```bash
openssl rand -hex 4
```

## Безопасность API

Порт `10085` лучше:
- слушать только на приватном IP / VPN между backend и нодой
- или закрыть firewall и пускать только IP backend

В админке при добавлении сервера:

```
name|host|port|type|publicKey|shortId|sni
```

`apiHost` по умолчанию = host. Если API на другом адресе — позже добавим отдельное поле в форму.

## inboundTag

Должен совпадать с `tag` inbound в конфиге Xray (по умолчанию `vless-reality`).
