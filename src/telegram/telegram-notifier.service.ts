import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { PriceDropAlert } from "../cmc/price-alert.types";
import { SubscriberRepositoryService } from "./subscriber-repository.service";

@Injectable()
export class TelegramNotifierService {
  private readonly logger = new Logger(TelegramNotifierService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly subscriberRepository: SubscriberRepositoryService,
  ) {}

  async sendPriceDropAlert(alert: PriceDropAlert): Promise<boolean> {
    const botToken = this.configService.get<string>("TELEGRAM_BOT_TOKEN");
    const subscribers = this.subscriberRepository.all();

    if (!botToken) {
      this.logger.warn("Telegram bot token is missing");
      return false;
    }

    if (!subscribers.length) {
      this.logger.warn("No Telegram subscribers registered");
      return false;
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const text = this.formatPriceDropAlert(alert);
    let sentCount = 0;

    for (const subscriber of subscribers) {
      try {
        await firstValueFrom(
          this.httpService.post(
            url,
            {
              chat_id: subscriber.chatId,
              disable_web_page_preview: true,
              text,
            },
            {
              timeout: 15000,
            },
          ),
        );
        sentCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to send Telegram alert to ${subscriber.chatId}: ${message}`,
        );
      }
    }

    return sentCount > 0;
  }

  private formatPriceDropAlert(alert: PriceDropAlert): string {
    const { coin, quote, thresholdPercent } = alert;
    const change = this.formatPercent(quote.percentChange1h);
    const price = this.formatUsd(quote.price);
    const rank = coin.cmcRank ? `#${coin.cmcRank}` : "n/a";
    const source = coin.source ?? "CoinMarketCap";
    const sourceRankLabel = coin.sourceRankLabel ?? "رتبه CMC";
    const sourceUrl =
      coin.sourceUrl ?? `https://coinmarketcap.com/currencies/${coin.slug}/`;
    const updatedAt = this.formatUpdatedAt(
      quote.lastUpdated ?? coin.lastUpdated,
    );

    return [
      "هشدار ریزش یک‌ساعته",
      "",
      `نام: ${coin.name} (${coin.symbol})`,
      `منبع: ${source}`,
      `${sourceRankLabel}: ${rank}`,
      `تغییر ۱ ساعته: ${change}`,
      `آستانه: کمتر از ${thresholdPercent}%`,
      `قیمت USD: ${price}`,
      `آخرین بروزرسانی: ${updatedAt}`,
      `لینک: ${sourceUrl}`,
    ].join("\n");
  }

  private formatPercent(value: number | undefined): string {
    if (value === undefined) {
      return "n/a";
    }

    return `${value.toFixed(2)}%`;
  }

  private formatUpdatedAt(value: string | undefined): string {
    if (!value) {
      return "نامشخص";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return value;
    }

    const formatted = new Intl.DateTimeFormat("fa-IR", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "Asia/Tehran",
    })
      .format(date)
      .replace(/,/g, "،");

    return `${formatted}، تهران`;
  }

  private formatUsd(value: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumSignificantDigits: 8,
    }).format(value);
  }
}
