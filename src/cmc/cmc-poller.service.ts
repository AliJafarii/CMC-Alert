import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { TelegramNotifierService } from "../telegram/telegram-notifier.service";
import { AlertStateService } from "./alert-state.service";
import { CmcService } from "./cmc.service";
import { CmcCryptoCurrency } from "./cmc.types";
import { CoinGeckoService } from "./coingecko.service";
import { PriceAlertService } from "./price-alert.service";

interface ProcessCoinsResult {
  alertCount: number;
  alerts: string[];
}

@Injectable()
export class CmcPollerService implements OnModuleInit {
  private readonly logger = new Logger(CmcPollerService.name);
  private isRunning = false;

  constructor(
    private readonly alertStateService: AlertStateService,
    private readonly cmcService: CmcService,
    private readonly coinGeckoService: CoinGeckoService,
    private readonly priceAlertService: PriceAlertService,
    private readonly telegramNotifierService: TelegramNotifierService,
  ) {}

  async onModuleInit() {
    await this.poll();
  }

  @Cron(process.env.CMC_POLL_CRON ?? "0 * * * * *")
  async poll() {
    if (this.isRunning) {
      this.logger.warn("Previous poll is still running; skipping this tick");
      return;
    }

    this.isRunning = true;

    try {
      const listings = await this.cmcService.fetchListings();
      const coins = listings.data?.cryptoCurrencyList ?? [];

      if (!coins.length) {
        this.logger.warn(
          `No coins returned. CMC status: ${JSON.stringify(listings.status)}`,
        );
        return;
      }

      const cmcResult = await this.processCoins(coins);
      const cmcPriorityKeys = this.createPriorityKeys(coins);
      const coinGeckoCoins = await this.coinGeckoService.fetchListings();
      const coinGeckoOnlyCoins = coinGeckoCoins.filter(
        (coin) => !this.hasPriorityKey(coin, cmcPriorityKeys),
      );
      const coinGeckoResult = await this.processCoins(coinGeckoOnlyCoins);
      const totalAlertCount = cmcResult.alertCount + coinGeckoResult.alertCount;

      this.logger.log(
        [
          `Fetched ${coins.length} CMC coins and ${coinGeckoCoins.length} CoinGecko coins (${coinGeckoOnlyCoins.length} after CMC priority filter).`,
          `Worst CMC: ${this.describeWorstCoin(coins)}.`,
          `Worst CoinGecko: ${this.describeWorstCoin(coinGeckoOnlyCoins)}.`,
          `Sent ${totalAlertCount} new Telegram alerts below ${this.priceAlertService.thresholdPercent}%.`,
        ].join(" "),
      );

      for (const alert of [...cmcResult.alerts, ...coinGeckoResult.alerts]) {
        this.logger.log(`Alert sent: ${alert}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`CoinMarketCap poll failed: ${message}`);
    } finally {
      this.isRunning = false;
    }
  }

  private async processCoins(
    coins: CmcCryptoCurrency[],
  ): Promise<ProcessCoinsResult> {
    let alertCount = 0;
    const alerts: string[] = [];

    for (const coin of coins) {
      const alert = this.priceAlertService.createDropAlert(coin);

      if (!alert) {
        if (this.priceAlertService.isRecovered(coin)) {
          this.alertStateService.markRecovered(coin);
        }

        continue;
      }

      if (this.alertStateService.isActive(coin)) {
        continue;
      }

      try {
        const isSent =
          await this.telegramNotifierService.sendPriceDropAlert(alert);

        if (isSent) {
          this.alertStateService.markTriggered(coin);
          alertCount += 1;
          alerts.push(this.describeCoin(coin));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to send Telegram alert for ${coin.symbol}: ${message}`,
        );
      }
    }

    return {
      alertCount,
      alerts,
    };
  }

  private createPriorityKeys(coins: CmcCryptoCurrency[]): Set<string> {
    const keys = new Set<string>();

    for (const coin of coins) {
      for (const key of this.getCoinKeys(coin)) {
        keys.add(key);
      }
    }

    return keys;
  }

  private hasPriorityKey(
    coin: CmcCryptoCurrency,
    priorityKeys: Set<string>,
  ): boolean {
    return this.getCoinKeys(coin).some((key) => priorityKeys.has(key));
  }

  private getCoinKeys(coin: CmcCryptoCurrency): string[] {
    return [coin.name, coin.slug]
      .filter(Boolean)
      .map((value) => value.toLowerCase());
  }

  private describeWorstCoin(coins: CmcCryptoCurrency[]): string {
    if (!coins.length) {
      return "n/a";
    }

    const sortedCoins = [...coins].sort(
      (first, second) =>
        (first.quotes?.[0]?.percentChange1h ?? Number.POSITIVE_INFINITY) -
        (second.quotes?.[0]?.percentChange1h ?? Number.POSITIVE_INFINITY),
    );

    return this.describeCoin(sortedCoins[0]);
  }

  private describeCoin(coin: CmcCryptoCurrency): string {
    const source = coin.source ?? "CoinMarketCap";
    const quote = coin.quotes?.[0];
    const change =
      quote?.percentChange1h === undefined
        ? "n/a"
        : `${quote.percentChange1h.toFixed(2)}%`;
    const price = quote?.price === undefined ? "n/a" : `$${quote.price}`;

    return `${source} ${coin.name} (${coin.symbol}) ${change} price=${price} slug=${coin.slug}`;
  }
}
