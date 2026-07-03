# cmc-alert

NestJS Telegram bot that monitors crypto markets and sends alerts for sharp
one-hour price drops. It checks CoinMarketCap first, then CoinGecko as a
secondary source.

## Run

```bash
npm install
npm run build
npm start
```

For development:

```bash
npm run start:dev
```

## Config

Copy `.env.example` to `.env` if you want to change defaults.

```env
CMC_PAGE_LIMIT=5000
CMC_POLL_CRON="0 * * * * *"
CMC_ALERT_THRESHOLD_PERCENT=-70
CMC_ANOMALY_LOOKBACK_DAYS=7
CMC_ANOMALY_DROP_PERCENT=50
CMC_ANOMALY_PUMP_PERCENT=100
CMC_ANOMALY_MIN_DROPS=2
CMC_ANOMALY_MIN_PUMPS=2
CMC_ANOMALY_CACHE_HOURS=24
COINGECKO_PAGES_PER_POLL=1
TELEGRAM_BOT_TOKEN="put-your-token-here"
TELEGRAM_CHAT_ID="optional-default-chat-id"
```

`CMC_POLL_CRON="0 * * * * *"` means once per minute, at second zero.
`CMC_ALERT_THRESHOLD_PERCENT=-70` means alert when a coin drops more than 70%
in one hour.
`TELEGRAM_CHAT_ID` is optional; users can subscribe with `/start`, but setting a
default chat id seeds the first subscriber on startup.

The anomaly filter checks seven-day price history before sending a drop alert.
By default it suppresses a coin only when the history has at least two drops of
50% or more and at least two rebounds of 100% or more. This catches binary,
fake-looking histories such as Polymath while avoiding coins that only drift or
drop without repeated explosive rebounds. Results are cached in
`data/price-anomaly-state.json` for 24 hours.

## systemd

Copy `cmc-alert.service.example` to `/etc/systemd/system/cmc-alert.service`
after creating `/root/cmc-alert/.env`, then install the healthcheck and enable
both units:

```bash
sudo install -m 755 scripts/healthcheck.sh /usr/local/sbin/cmc-alert-healthcheck
sudo cp cmc-alert-health.service.example /etc/systemd/system/cmc-alert-health.service
sudo cp cmc-alert-health.timer.example /etc/systemd/system/cmc-alert-health.timer
sudo cp cmc-alert.service.example /etc/systemd/system/cmc-alert.service
sudo systemctl daemon-reload
sudo systemctl enable --now cmc-alert
sudo systemctl enable --now cmc-alert-health.timer
sudo systemctl status cmc-alert
```

## Output

Every minute the bot checks coins and sends a Telegram alert when the USD quote
passes the configured one-hour drop threshold. CoinMarketCap is fetched first,
sorted by one-hour change from lowest to highest, and paginated until the full
CMC list is checked.
Before an alert is sent, the bot loads seven days of price history for that coin
from the matching source and suppresses coins with repeated extreme drop/pump
behavior.
CoinMarketCap has priority: CoinGecko coins already present in the current
CoinMarketCap listing are skipped to avoid duplicate alerts. CoinGecko is read
from its market list in pages of 250 coins and sorted by the one-hour change
from lowest to highest before alerting.
`COINGECKO_PAGES_PER_POLL` controls how many CoinGecko pages are checked on each
poll, and `data/coingecko-state.json` stores the next page so the bot keeps
cycling through all CoinGecko pages after restarts.
Alert state is stored in `data/alert-state.json`, so restarts do not resend the
same active alert.

Users can subscribe by sending `/start` to the Telegram bot. They can stop
alerts with `/stop` and check the worker with `/status`.

The bot logs:

- how many coins were fetched from CoinMarketCap and CoinGecko
- how many new Telegram alerts were sent

The first poll runs immediately when the app starts; after that it runs every minute.
