#!/usr/bin/env bash

set -u

URL="http://127.0.0.1:3000/api/health"
LOG="/var/log/4stepsvpn-healthcheck.log"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

if curl -fsS --max-time 5 "$URL" >/dev/null; then
  exit 0
fi

echo "$(timestamp) healthcheck failed, restarting 4stepsvpn" >> "$LOG"

pm2 restart 4stepsvpn >> "$LOG" 2>&1

sleep 5

if curl -fsS --max-time 5 "$URL" >/dev/null; then
  echo "$(timestamp) recovery successful" >> "$LOG"
  exit 0
fi

echo "$(timestamp) recovery failed" >> "$LOG"
exit 1
