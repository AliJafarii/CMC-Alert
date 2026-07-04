import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { firstValueFrom } from "rxjs";
import { CmcCryptoCurrency, CoinGeckoMarketCoin } from "./cmc.types";

interface CoinGeckoState {
  nextPage: number;
  cooldownUntil?: string;
}

@Injectable()
export class CoinGeckoService {
  private readonly logger = new Logger(CoinGeckoService.name);
  private readonly url = "https://api.coingecko.com/api/v3/coins/markets";
  private readonly statePath = join(
    process.cwd(),
    "data",
    "coingecko-state.json",
  );
  private readonly perPage = 250;
  private readonly cooldownMs = 60_000;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async fetchListings(): Promise<CmcCryptoCurrency[]> {
    const state = this.loadState();
    const cooldownUntil = state.cooldownUntil
      ? new Date(state.cooldownUntil).getTime()
      : 0;

    if (cooldownUntil > Date.now()) {
      this.logger.warn(
        `CoinGecko is cooling down until ${state.cooldownUntil}; keeping page ${state.nextPage}`,
      );
      return [];
    }

    const pagesPerPoll = this.getPagesPerPoll();
    const fetchedCoins: CmcCryptoCurrency[] = [];
    let nextPage = Math.max(1, state.nextPage || 1);
    let totalPages: number | undefined;

    for (let index = 0; index < pagesPerPoll; index += 1) {
      const result = await this.fetchPage(nextPage);

      if (result.status === 429) {
        this.saveState({
          nextPage,
          cooldownUntil: new Date(Date.now() + this.cooldownMs).toISOString(),
        });
        this.logger.warn(
          `CoinGecko responded with HTTP 429 on page ${nextPage}; cooling down for ${this.cooldownMs / 1000}s`,
        );
        break;
      }

      if (result.status >= 400) {
        this.logger.warn(
          `CoinGecko page ${nextPage} responded with HTTP ${result.status}; keeping page for next poll`,
        );
        this.saveState({ nextPage });
        break;
      }

      fetchedCoins.push(...result.coins);
      totalPages = result.totalPages ?? totalPages;

      this.logger.log(
        `CoinGecko markets page ${nextPage}${totalPages ? `/${totalPages}` : ""} responded with HTTP ${result.status}. Parsed ${result.coins.length} coins`,
      );

      if (!result.coins.length && nextPage > 1) {
        nextPage = 1;
        break;
      }

      nextPage =
        totalPages && nextPage >= totalPages ? 1 : Math.max(1, nextPage + 1);
    }

    this.saveState({ nextPage });

    return fetchedCoins
      .filter((coin) => coin.quotes?.[0]?.percentChange1h !== undefined)
      .sort((first, second) => {
        const firstChange = first.quotes?.[0]?.percentChange1h ?? 0;
        const secondChange = second.quotes?.[0]?.percentChange1h ?? 0;
        return firstChange - secondChange;
      });
  }

  private async fetchPage(page: number): Promise<{
    coins: CmcCryptoCurrency[];
    status: number;
    totalPages?: number;
  }> {
    const response = await firstValueFrom(
      this.httpService.get<CoinGeckoMarketCoin[]>(this.url, {
        params: {
          vs_currency: "usd",
          order: "market_cap_desc",
          per_page: this.perPage,
          page,
          sparkline: false,
          price_change_percentage: "1h",
        },
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "fa,en-US;q=0.9,en;q=0.8",
          "cache-control": "no-cache",
          origin: "https://www.coingecko.com",
          referer: "https://www.coingecko.com/",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        },
        timeout: 20000,
        validateStatus: (status) => status < 500,
      }),
    );

    const total = Number(response.headers?.total);
    const perPage = Number(response.headers?.["per-page"]) || this.perPage;
    const totalPages =
      Number.isFinite(total) && total > 0
        ? Math.ceil(total / perPage)
        : undefined;
    const data = Array.isArray(response.data) ? response.data : [];

    return {
      coins: data.map((coin) => this.mapCoin(coin)),
      status: response.status,
      totalPages,
    };
  }

  private mapCoin(coin: CoinGeckoMarketCoin): CmcCryptoCurrency {
    return {
      id: `coingecko:${coin.id}`,
      name: coin.name,
      symbol: coin.symbol.toUpperCase(),
      slug: coin.id,
      cmcRank: coin.market_cap_rank ?? undefined,
      source: "CoinGecko",
      sourceRankLabel: "رتبه CoinGecko",
      sourceUrl: `https://www.coingecko.com/en/coins/${coin.id}`,
      quotes: [
        {
          name: "USD",
          price: coin.current_price ?? 0,
          volume24h: coin.total_volume ?? undefined,
          percentChange1h:
            coin.price_change_percentage_1h_in_currency ?? undefined,
          percentChange24h: coin.price_change_percentage_24h ?? undefined,
          marketCap: coin.market_cap ?? undefined,
          lastUpdated: coin.last_updated ?? new Date().toISOString(),
        },
      ],
    };
  }

  private getPagesPerPoll(): number {
    const configuredPages = Number(
      this.configService.get<string>("COINGECKO_PAGES_PER_POLL") ?? "1",
    );

    if (!Number.isFinite(configuredPages) || configuredPages < 1) {
      return 1;
    }

    return Math.min(Math.floor(configuredPages), 20);
  }

  private loadState(): CoinGeckoState {
    if (!existsSync(this.statePath)) {
      return { nextPage: 1 };
    }

    try {
      const state = JSON.parse(
        readFileSync(this.statePath, "utf8"),
      ) as Partial<CoinGeckoState>;
      return {
        nextPage:
          typeof state.nextPage === "number" && state.nextPage > 0
            ? Math.floor(state.nextPage)
            : 1,
        cooldownUntil: state.cooldownUntil,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to read CoinGecko state; starting from page 1: ${message}`,
      );
      return { nextPage: 1 };
    }
  }

  private saveState(state: CoinGeckoState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.tmp`;

    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tempPath, this.statePath);
  }
}
