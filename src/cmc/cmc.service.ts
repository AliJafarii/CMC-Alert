import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { firstValueFrom } from "rxjs";
import { CmcCryptoCurrency, CmcListingResponse } from "./cmc.types";

@Injectable()
export class CmcService {
  private readonly logger = new Logger(CmcService.name);
  private readonly url =
    "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/listing";

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async fetchListings(): Promise<CmcListingResponse> {
    const limit = this.getPageLimit();
    const allCoins: CmcCryptoCurrency[] = [];
    let start = 1;
    let responseStatus: CmcListingResponse["status"];
    let totalCount: number | undefined;

    while (true) {
      const response = await this.fetchPage(start, limit);
      const coins = response.data?.cryptoCurrencyList ?? [];
      responseStatus = response.status;
      totalCount =
        this.parseTotalCount(response.data?.totalCount) ?? totalCount;
      allCoins.push(...coins);

      this.logger.debug(
        `CMC page start=${start} limit=${limit} returned ${coins.length} coins`,
      );

      if (!coins.length) {
        break;
      }

      start += coins.length;

      if (totalCount !== undefined && allCoins.length >= totalCount) {
        break;
      }
    }

    this.logger.debug(`CMC returned ${allCoins.length} total coins`);

    return {
      data: {
        cryptoCurrencyList: allCoins,
        totalCount,
      },
      status: responseStatus,
    };
  }

  private async fetchPage(
    start: number,
    limit: number,
  ): Promise<CmcListingResponse> {
    const response = await firstValueFrom(
      this.httpService.get<CmcListingResponse>(this.url, {
        params: {
          start,
          limit,
          sortBy: "percent_change_1h",
          sortType: "asc",
          convert: "USD,BTC,ETH",
          cryptoType: "all",
          tagType: "all",
          audited: false,
          aux: [
            "ath",
            "atl",
            "high24h",
            "low24h",
            "num_market_pairs",
            "cmc_rank",
            "date_added",
            "max_supply",
            "circulating_supply",
            "total_supply",
            "volume_7d",
            "volume_30d",
            "self_reported_circulating_supply",
            "self_reported_market_cap",
          ].join(","),
        },
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "fa,en-US;q=0.9,en;q=0.8",
          "cache-control": "no-cache",
          origin: "https://coinmarketcap.com",
          platform: "web",
          priority: "u=1, i",
          referer: "https://coinmarketcap.com/",
          "sec-ch-ua":
            '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
          "x-request-id": this.createRequestId(),
        },
        timeout: 20000,
      }),
    );

    this.logger.debug(`CMC responded with HTTP ${response.status}`);
    return response.data;
  }

  private getPageLimit(): number {
    const configuredLimit = Number(
      this.configService.get<string>("CMC_PAGE_LIMIT") ?? "5000",
    );

    if (!Number.isFinite(configuredLimit) || configuredLimit < 1) {
      return 5000;
    }

    return Math.min(Math.floor(configuredLimit), 5000);
  }

  private parseTotalCount(
    totalCount: string | number | undefined,
  ): number | undefined {
    const parsedTotalCount = Number(totalCount);
    return Number.isFinite(parsedTotalCount) && parsedTotalCount > 0
      ? parsedTotalCount
      : undefined;
  }

  private createRequestId(): string {
    return randomUUID().replaceAll("-", "");
  }
}
