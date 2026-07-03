import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CmcCryptoCurrency, CmcQuote } from "./cmc.types";
import { PriceDropAlert } from "./price-alert.types";

const DEFAULT_THRESHOLD_PERCENT = -70;

@Injectable()
export class PriceAlertService {
  readonly thresholdPercent: number;

  constructor(private readonly configService: ConfigService) {
    this.thresholdPercent = this.getThresholdPercent();
  }

  createDropAlert(coin: CmcCryptoCurrency): PriceDropAlert | null {
    const quote = this.findUsdQuote(coin);

    if (
      quote?.percentChange1h === undefined ||
      quote.percentChange1h >= this.thresholdPercent
    ) {
      return null;
    }

    return {
      coin,
      quote,
      thresholdPercent: this.thresholdPercent,
    };
  }

  isRecovered(coin: CmcCryptoCurrency): boolean {
    const quote = this.findUsdQuote(coin);
    return (
      quote?.percentChange1h !== undefined &&
      quote.percentChange1h >= this.thresholdPercent
    );
  }

  private findUsdQuote(coin: CmcCryptoCurrency): CmcQuote | undefined {
    return coin.quotes?.find((quote) => quote.name === "USD");
  }

  private getThresholdPercent(): number {
    const configuredThreshold = Number(
      this.configService.get<string>("CMC_ALERT_THRESHOLD_PERCENT") ??
        String(DEFAULT_THRESHOLD_PERCENT),
    );

    return Number.isFinite(configuredThreshold)
      ? configuredThreshold
      : DEFAULT_THRESHOLD_PERCENT;
  }
}
