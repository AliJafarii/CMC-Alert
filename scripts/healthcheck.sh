#!/usr/bin/env bash
set -euo pipefail

service="cmc-alert.service"

if ! systemctl is-active --quiet "$service"; then
  systemctl restart "$service"
  exit 0
fi

if ! journalctl -u "$service" --since "4 minutes ago" --no-pager \
  | grep -Eq "CmcPollerService|CoinMarketCap polling bot started|CMC returned"; then
  systemctl restart "$service"
fi
