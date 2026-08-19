#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

install -m 750 \
  "$PROJECT_DIR/deploy/4stepsvpn-healthcheck.sh" \
  /usr/local/bin/4stepsvpn-healthcheck.sh

install -m 644 \
  "$PROJECT_DIR/deploy/4stepsvpn-healthcheck.service" \
  /etc/systemd/system/4stepsvpn-healthcheck.service

install -m 644 \
  "$PROJECT_DIR/deploy/4stepsvpn-healthcheck.timer" \
  /etc/systemd/system/4stepsvpn-healthcheck.timer

systemctl daemon-reload
systemctl enable --now 4stepsvpn-healthcheck.timer

echo "4StepsVPN healthcheck installed"
systemctl status 4stepsvpn-healthcheck.timer --no-pager
