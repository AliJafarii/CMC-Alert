#!/usr/bin/env bash
set -euo pipefail

services=(
  "cmc-alert.service|عملیاتی|/root/cmc-alert/.env"
  "cmc-alert-test.service|تست|/root/cmc-alert-test/.env"
)

host="$(hostname)"
restarted=()
statuses=()

load_telegram_config() {
  local env_file="$1"

  TELEGRAM_BOT_TOKEN=""
  TELEGRAM_CHAT_ID=""
  TELEGRAM_ADMIN_CHAT_IDS=""

  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi

  HEALTH_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  HEALTH_CHAT_ID="${TELEGRAM_ADMIN_CHAT_IDS%%,*}"
  HEALTH_CHAT_ID="${HEALTH_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"
}

send_telegram() {
  local text="$1"

  if [[ -z "${HEALTH_BOT_TOKEN:-}" || -z "${HEALTH_CHAT_ID:-}" ]]; then
    return 0
  fi

  curl -fsS \
    --max-time 15 \
    -X POST "https://api.telegram.org/bot${HEALTH_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${HEALTH_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    -d "disable_web_page_preview=true" >/dev/null || true
}

service_has_recent_activity() {
  local service="$1"

  journalctl -u "$service" --since "6 minutes ago" --no-pager \
    | grep -Eq "CmcPollerService|CoinMarketCap polling bot started|CMC returned|Fetched [0-9]+ CMC coins"
}

for item in "${services[@]}"; do
  IFS="|" read -r service label env_file <<<"$item"
  action="بدون تغییر"

  if ! systemctl is-active --quiet "$service"; then
    systemctl restart "$service" || true
    action="ری‌استارت شد"
    restarted+=("${label}: سرویس فعال نبود")
  elif ! service_has_recent_activity "$service"; then
    systemctl restart "$service" || true
    action="ری‌استارت شد"
    restarted+=("${label}: لاگ پولینگ تازه نداشت")
  fi

  sleep 1

  if systemctl is-active --quiet "$service"; then
    statuses+=("وضعیت ${label}: active، ${action}")
  else
    statuses+=("وضعیت ${label}: inactive، ${action}")
  fi
done

load_telegram_config "/root/cmc-alert/.env"

if ((${#restarted[@]})); then
  message=$'هشدار سلامت بات‌های CMC\n\n'
  message+="میزبان: ${host}"$'\n'
  message+="زمان: $(TZ=Asia/Tehran date '+%Y-%m-%d %H:%M:%S %Z')"$'\n\n'

  for line in "${restarted[@]}"; do
    message+="رخداد: ${line}"$'\n'
  done

  message+=$'\n'

  for line in "${statuses[@]}"; do
    message+="${line}"$'\n'
  done

  send_telegram "$message"
fi
