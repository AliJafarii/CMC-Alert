import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { firstValueFrom } from "rxjs";
import { CmcCryptoCurrency } from "./cmc.types";

interface CmcChartResponse {
  data?: {
    points?: Record<string, { v?: number[] }>;
  };
}

interface CoinGeckoChartResponse {
  prices?: [number, number][];
}

interface PricePoint {
  timestamp: number;
  price: number;
}

interface AnomalyCacheEntry {
  checkedAt: string;
  isAnomalous: boolean;
  source: string;
  coinId: string | number;
  name: string;
  symbol: string;
  slug: string;
  reason: string;
}

interface AnomalyStats {
  drops: number;
  pumps: number;
  maxDrop: number;
  maxPump: number;
  pointCount: number;
}

@Injectable()
export class PriceAnomalyService {
  private readonly logger = new Logger(PriceAnomalyService.name);
  private readonly statePath = join(
    process.cwd(),
    "data",
    "price-anomaly-state.json",
  );
  private readonly cache = new Map<string, AnomalyCacheEntry>();

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.load();
  }

  async isAnomalous(coin: CmcCryptoCurrency): Promise<boolean> {
    const cacheKey = this.getCacheKey(coin);
    const cached = this.cache.get(cacheKey);

    if (cached && !this.isExpired(cached)) {
      return cached.isAnomalous;
    }

    try {
      const points = await this.fetchPriceHistory(coin);
      const result = this.analyze(points);
      const reason = this.formatReason(result);

      this.cache.set(cacheKey, {
        checkedAt: new Date().toISOString(),
        isAnomalous: result.isAnomalous,
        source: coin.source ?? "CoinMarketCap",
        coinId: coin.id,
        name: coin.name,
        symbol: coin.symbol,
        slug: coin.slug,
        reason,
      });
      this.save();

      if (result.isAnomalous) {
        this.logger.warn(
          `Suppressing anomalous price alert for ${this.describeCoin(coin)}: ${reason}`,
        );
      }

      return result.isAnomalous;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not check seven-day anomaly for ${this.describeCoin(coin)}: ${message}`,
      );
      return false;
    }
  }

  private async fetchPriceHistory(
    coin: CmcCryptoCurrency,
  ): Promise<PricePoint[]> {
    if (coin.source === "CoinGecko") {
      return this.fetchCoinGeckoHistory(coin);
    }

    return this.fetchCoinMarketCapHistory(coin);
  }

  private async fetchCoinMarketCapHistory(
    coin: CmcCryptoCurrency,
  ): Promise<PricePoint[]> {
    const response = await firstValueFrom(
      this.httpService.get<CmcChartResponse>(
        "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail/chart",
        {
          params: {
            id: coin.id,
            range: `${this.getLookbackDays()}D`,
          },
          headers: {
            accept: "application/json, text/plain, */*",
            "accept-language": "fa,en-US;q=0.9,en;q=0.8",
            "cache-control": "no-cache",
            origin: "https://coinmarketcap.com",
            referer: "https://coinmarketcap.com/",
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
          },
          timeout: 20000,
        },
      ),
    );

    return Object.entries(response.data.data?.points ?? {})
      .map(([timestamp, point]) => ({
        timestamp: Number(timestamp) * 1000,
        price: Number(point.v?.[0]),
      }))
      .filter((point) => Number.isFinite(point.price) && point.price > 0)
      .sort((first, second) => first.timestamp - second.timestamp);
  }

  private async fetchCoinGeckoHistory(
    coin: CmcCryptoCurrency,
  ): Promise<PricePoint[]> {
    const response = await firstValueFrom(
      this.httpService.get<CoinGeckoChartResponse>(
        `https://api.coingecko.com/api/v3/coins/${coin.slug}/market_chart`,
        {
          params: {
            vs_currency: "usd",
            days: this.getLookbackDays(),
          },
          headers: {
            accept: "application/json",
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
          },
          timeout: 20000,
        },
      ),
    );

    return (response.data.prices ?? [])
      .map(([timestamp, price]) => ({
        timestamp,
        price: Number(price),
      }))
      .filter((point) => Number.isFinite(point.price) && point.price > 0)
      .sort((first, second) => first.timestamp - second.timestamp);
  }

  private analyze(points: PricePoint[]): {
    isAnomalous: boolean;
    stats: AnomalyStats;
  } {
    const returns = this.calculateReturns(points);
    const minDropPercent = this.getMinDropPercent();
    const minPumpPercent = this.getMinPumpPercent();
    const stats: AnomalyStats = {
      drops: returns.filter((value) => value <= minDropPercent).length,
      pumps: returns.filter((value) => value >= minPumpPercent).length,
      maxDrop: returns.length ? Math.min(...returns) : 0,
      maxPump: returns.length ? Math.max(...returns) : 0,
      pointCount: points.length,
    };

    return {
      isAnomalous:
        stats.drops >= this.getMinDropCount() &&
        stats.pumps >= this.getMinPumpCount(),
      stats,
    };
  }

  private calculateReturns(points: PricePoint[]): number[] {
    const returns: number[] = [];

    for (let index = 1; index < points.length; index += 1) {
      const previousPrice = points[index - 1].price;
      const currentPrice = points[index].price;

      returns.push(((currentPrice - previousPrice) / previousPrice) * 100);
    }

    return returns;
  }

  private formatReason(result: {
    isAnomalous: boolean;
    stats: AnomalyStats;
  }): string {
    const { stats } = result;

    return [
      `points=${stats.pointCount}`,
      `drops<=${this.getMinDropPercent()}%: ${stats.drops}`,
      `pumps>=${this.getMinPumpPercent()}%: ${stats.pumps}`,
      `maxDrop=${stats.maxDrop.toFixed(2)}%`,
      `maxPump=${stats.maxPump.toFixed(2)}%`,
    ].join(", ");
  }

  private getCacheKey(coin: CmcCryptoCurrency): string {
    return `${coin.source ?? "CoinMarketCap"}:${coin.id}:${coin.slug}`;
  }

  private describeCoin(coin: CmcCryptoCurrency): string {
    return `${coin.source ?? "CoinMarketCap"} ${coin.name} (${coin.symbol})`;
  }

  private isExpired(entry: AnomalyCacheEntry): boolean {
    const checkedAt = new Date(entry.checkedAt).getTime();
    const cacheMs = this.getCacheHours() * 60 * 60 * 1000;

    return !Number.isFinite(checkedAt) || Date.now() - checkedAt > cacheMs;
  }

  private getLookbackDays(): number {
    return this.getNumber("CMC_ANOMALY_LOOKBACK_DAYS", 7, 1, 30);
  }

  private getCacheHours(): number {
    return this.getNumber("CMC_ANOMALY_CACHE_HOURS", 24, 1, 168);
  }

  private getMinDropCount(): number {
    return this.getNumber("CMC_ANOMALY_MIN_DROPS", 2, 1, 20);
  }

  private getMinPumpCount(): number {
    return this.getNumber("CMC_ANOMALY_MIN_PUMPS", 2, 1, 20);
  }

  private getMinDropPercent(): number {
    return -Math.abs(this.getNumber("CMC_ANOMALY_DROP_PERCENT", 50, 1, 99));
  }

  private getMinPumpPercent(): number {
    return this.getNumber("CMC_ANOMALY_PUMP_PERCENT", 100, 1, 10000);
  }

  private getNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(this.configService.get<string>(key) ?? fallback);

    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Math.min(Math.max(value, min), max);
  }

  private load(): void {
    if (!existsSync(this.statePath)) {
      return;
    }

    try {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as Record<
        string,
        AnomalyCacheEntry
      >;

      for (const [key, entry] of Object.entries(state)) {
        this.cache.set(key, entry);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to read anomaly state: ${message}`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(
      this.statePath,
      `${JSON.stringify(Object.fromEntries(this.cache), null, 2)}\n`,
      "utf8",
    );
  }
}
