import { HttpService } from "@nestjs/axios";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { firstValueFrom } from "rxjs";
import { SubscriberRepositoryService } from "./subscriber-repository.service";
import { TelegramUpdateState } from "./subscriber.types";

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  text?: string;
  chat: {
    id: number;
    first_name?: string;
    username?: string;
  };
}

interface TelegramReplyMarkup {
  keyboard: string[][];
  resize_keyboard: boolean;
  one_time_keyboard: boolean;
}

interface AnomalyStateEntry {
  checkedAt?: string;
  isAnomalous?: boolean;
  source?: string;
  coinId?: string | number;
  name?: string;
  symbol?: string;
  slug?: string;
  sourceUrl?: string;
  reason?: string;
}

interface TradeSettingsState {
  enabled?: boolean;
  mode?: "dry-run";
  solAmount?: number;
  walletAddress?: string;
  solanaOnly?: boolean;
  minLiquidityUsd?: number;
  allowedSolanaDexIds?: string[];
}

@Injectable()
export class TelegramUpdateService implements OnModuleInit {
  private readonly logger = new Logger(TelegramUpdateService.name);
  private readonly statePath = join(
    process.cwd(),
    "data",
    "telegram-state.json",
  );
  private readonly anomalyStatePath = join(
    process.cwd(),
    "data",
    "price-anomaly-state.json",
  );
  private readonly tradeSettingsPath = join(
    process.cwd(),
    "data",
    "trade-settings.json",
  );
  private isRunning = false;
  private offset = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly subscriberRepository: SubscriberRepositoryService,
  ) {}

  async onModuleInit() {
    this.offset = this.loadOffset();
    await this.pollUpdates();
  }

  @Cron("*/5 * * * * *")
  async pollUpdates(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      const botToken = this.configService.get<string>("TELEGRAM_BOT_TOKEN");

      if (!botToken) {
        this.logger.warn("Telegram bot token is missing");
        return;
      }

      const response = await firstValueFrom(
        this.httpService.get<TelegramGetUpdatesResponse>(
          `https://api.telegram.org/bot${botToken}/getUpdates`,
          {
            params: {
              offset: this.offset || undefined,
              timeout: 0,
              allowed_updates: JSON.stringify(["message"]),
            },
            timeout: 15000,
          },
        ),
      );

      for (const update of response.data.result ?? []) {
        await this.handleUpdate(update);
        this.offset = update.update_id + 1;
      }

      this.saveOffset();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to poll Telegram updates: ${message}`);
    } finally {
      this.isRunning = false;
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;

    if (!message?.text) {
      return;
    }

    const text = message.text.trim();
    const chatId = String(message.chat.id);

    if (text.startsWith("/start")) {
      this.subscriberRepository.upsert({
        chatId,
        firstName: message.chat.first_name,
        username: message.chat.username,
      });

      this.logger.log(
        `Registered Telegram subscriber ${chatId}. Total subscribers: ${this.subscriberRepository.count()}`,
      );
      await this.sendText(
        chatId,
        "بات فعال شد. از این به بعد هشدارهای ریزش یک‌ساعته را دریافت می‌کنی.",
        this.getAdminReplyMarkup(chatId),
      );
      return;
    }

    if (text.startsWith("/stop")) {
      this.subscriberRepository.remove(chatId);
      this.logger.log(
        `Removed Telegram subscriber ${chatId}. Total subscribers: ${this.subscriberRepository.count()}`,
      );
      await this.sendText(chatId, "ارسال هشدارها برای این حساب متوقف شد.");
      return;
    }

    if (text.startsWith("/status")) {
      await this.sendText(
        chatId,
        `بات روشن است. تعداد subscriberها: ${this.subscriberRepository.count()}`,
        this.getAdminReplyMarkup(chatId),
      );
      return;
    }

    if (
      text.startsWith("/anomalies") ||
      text === "گزارش کوین‌های آنرمال"
    ) {
      await this.handleAnomaliesCommand(chatId, text);
      return;
    }

    if (this.isTradeSettingsCommand(text)) {
      await this.handleTradeSettingsCommand(chatId, text);
    }
  }

  private async handleAnomaliesCommand(
    chatId: string,
    text: string,
  ): Promise<void> {
    if (!this.isAdmin(chatId)) {
      await this.sendText(chatId, "این دستور فقط برای ادمین فعال است.");
      return;
    }

    const limit = this.parseLimit(text);
    const entries = this.loadAnomalyEntries()
      .filter((entry) => entry.isAnomalous)
      .sort((first, second) => {
        const firstTime = new Date(first.checkedAt ?? 0).getTime();
        const secondTime = new Date(second.checkedAt ?? 0).getTime();
        return secondTime - firstTime;
      });

    if (!entries.length) {
      await this.sendText(chatId, "فعلا هیچ کوین آنرمالی در state ثبت نشده.");
      return;
    }

    const visibleEntries = entries.slice(0, limit);
    const lines = [
      `گزارش کوین‌های آنرمال ثبت‌شده: ${entries.length}`,
      `تعداد نمایش در این پیام: ${visibleEntries.length}`,
      "",
      ...visibleEntries.map((entry, index) =>
        [
          `${index + 1}. نام: ${entry.name ?? "ناشناخته"} (${entry.symbol ?? "n/a"})`,
          `منبع: ${entry.source ?? "n/a"}`,
          `شناسه: ${entry.coinId ?? "n/a"}`,
          `اسلاگ: ${entry.slug ?? "n/a"}`,
          `زمان بررسی: ${entry.checkedAt ?? "n/a"}`,
          `دلیل: ${entry.reason ?? "n/a"}`,
          `لینک: ${this.getAnomalyUrl(entry)}`,
        ].join("\n"),
      ),
    ];

    await this.sendLongText(chatId, lines.join("\n\n"));
  }

  private async sendText(
    chatId: string,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<void> {
    const botToken = this.configService.get<string>("TELEGRAM_BOT_TOKEN");

    if (!botToken) {
      return;
    }

    await firstValueFrom(
      this.httpService.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          chat_id: chatId,
          text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        },
        {
          timeout: 15000,
        },
      ),
    );
  }

  private async sendLongText(chatId: string, text: string): Promise<void> {
    const maxLength = 3900;
    const chunks: string[] = [];
    let remainingText = text;

    while (remainingText.length > maxLength) {
      const splitIndex = Math.max(
        remainingText.lastIndexOf("\n\n", maxLength),
        remainingText.lastIndexOf("\n", maxLength),
      );
      const index = splitIndex > 0 ? splitIndex : maxLength;
      chunks.push(remainingText.slice(0, index));
      remainingText = remainingText.slice(index).trimStart();
    }

    chunks.push(remainingText);

    for (const chunk of chunks) {
      await this.sendText(chatId, chunk);
    }
  }

  private isAdmin(chatId: string): boolean {
    const adminConfig =
      this.configService.get<string>("TELEGRAM_ADMIN_CHAT_IDS") ??
      this.configService.get<string>("TELEGRAM_ADMIN_CHAT_ID");
    const adminChatIds = this.parseChatIds(
      adminConfig ?? this.configService.get<string>("TELEGRAM_CHAT_ID") ?? "",
    );

    return adminChatIds.includes(chatId);
  }

  private getAdminReplyMarkup(
    chatId: string,
  ): TelegramReplyMarkup | undefined {
    if (!this.isAdmin(chatId)) {
      return undefined;
    }

    return {
      keyboard: [
        ["گزارش کوین‌های آنرمال"],
        ["وضعیت خرید تست"],
        ["فعال‌سازی خرید تست", "توقف خرید تست"],
        [
          "مبلغ خرید 0.01 سولانا",
          "مبلغ خرید 0.05 سولانا",
          "مبلغ خرید 0.1 سولانا",
        ],
        [
          "نقدینگی 500 دلار",
          "نقدینگی 1000 دلار",
          "نقدینگی 5000 دلار",
        ],
        ["نقدینگی 10000 دلار"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    };
  }

  private parseChatIds(value: string): string[] {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private parseLimit(text: string): number {
    const [, rawLimit] = text.split(/\s+/, 2);
    const limit = Number(rawLimit ?? 20);

    if (!Number.isFinite(limit)) {
      return 20;
    }

    return Math.min(Math.max(Math.floor(limit), 1), 50);
  }

  private loadAnomalyEntries(): AnomalyStateEntry[] {
    if (!existsSync(this.anomalyStatePath)) {
      return [];
    }

    try {
      const state = JSON.parse(
        readFileSync(this.anomalyStatePath, "utf8"),
      ) as Record<string, AnomalyStateEntry>;

      return Object.values(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to read anomaly state: ${message}`);
      return [];
    }
  }

  private getAnomalyUrl(entry: AnomalyStateEntry): string {
    if (entry.sourceUrl) {
      return entry.sourceUrl;
    }

    if (!entry.slug) {
      return "n/a";
    }

    if (entry.source === "CoinGecko") {
      return `https://www.coingecko.com/en/coins/${entry.slug}`;
    }

    return `https://coinmarketcap.com/currencies/${entry.slug}/`;
  }

  private isTradeSettingsCommand(text: string): boolean {
    return [
      "وضعیت خرید تست",
      "فعال‌سازی خرید تست",
      "توقف خرید تست",
      "مبلغ خرید 0.01 سولانا",
      "مبلغ خرید 0.05 سولانا",
      "مبلغ خرید 0.1 سولانا",
      "نقدینگی 500 دلار",
      "نقدینگی 1000 دلار",
      "نقدینگی 5000 دلار",
      "نقدینگی 10000 دلار",
    ].includes(text);
  }

  private async handleTradeSettingsCommand(
    chatId: string,
    text: string,
  ): Promise<void> {
    if (!this.isAdmin(chatId)) {
      await this.sendText(chatId, "این دستور فقط برای ادمین فعال است.");
      return;
    }

    const settings = this.loadTradeSettings();

    if (text === "فعال‌سازی خرید تست") {
      settings.enabled = true;
    }

    if (text === "توقف خرید تست") {
      settings.enabled = false;
    }

    const amountMatch = text.match(/مبلغ خرید ([0-9.]+) سولانا/);

    if (amountMatch) {
      settings.solAmount = Number(amountMatch[1]);
    }

    const liquidityMatch = text.match(/نقدینگی ([0-9.]+) دلار/);

    if (liquidityMatch) {
      settings.minLiquidityUsd = Number(liquidityMatch[1]);
    }

    settings.mode = "dry-run";
    this.saveTradeSettings(settings);

    await this.sendText(
      chatId,
      this.formatTradeSettings(settings),
      this.getAdminReplyMarkup(chatId),
    );
  }

  private loadTradeSettings(): TradeSettingsState {
    const defaults: TradeSettingsState = {
      enabled: false,
      mode: "dry-run",
      solAmount: 0.01,
      walletAddress: this.configService.get<string>("SOLANA_WALLET_ADDRESS") ?? "",
      solanaOnly: true,
      minLiquidityUsd: 1000,
      allowedSolanaDexIds: [
        "raydium",
        "orca",
        "meteora",
        "pumpswap",
        "pancakeswap",
        "lifinity",
        "jupiter-studio",
      ],
    };

    if (!existsSync(this.tradeSettingsPath)) {
      return defaults;
    }

    try {
      return {
        ...defaults,
        ...(JSON.parse(
          readFileSync(this.tradeSettingsPath, "utf8"),
        ) as TradeSettingsState),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to read trade settings: ${message}`);
      return defaults;
    }
  }

  private saveTradeSettings(settings: TradeSettingsState): void {
    mkdirSync(dirname(this.tradeSettingsPath), { recursive: true });
    writeFileSync(
      this.tradeSettingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf8",
    );
  }

  private formatTradeSettings(settings: TradeSettingsState): string {
    return [
      "وضعیت تنظیمات خرید تست",
      `فعال بودن: ${settings.enabled ? "بله" : "نه"}`,
      `حالت اجرا: ${settings.mode ?? "dry-run"}`,
      `مبلغ هر خرید: ${settings.solAmount ?? 0.01} SOL`,
      `ولیت: ${settings.walletAddress ?? "تنظیم نشده"}`,
      `شبکه: ${settings.solanaOnly ? "فقط Solana" : "چندشبکه‌ای"}`,
      `حداقل نقدینگی: ${settings.minLiquidityUsd ?? 1000} دلار`,
      `DEXهای مجاز: ${(settings.allowedSolanaDexIds ?? []).join(", ")}`,
    ].join("\n");
  }

  private loadOffset(): number {
    try {
      const state = JSON.parse(
        readFileSync(this.statePath, "utf8"),
      ) as TelegramUpdateState;

      return state.offset;
    } catch {
      return 0;
    }
  }

  private saveOffset(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(
      this.statePath,
      `${JSON.stringify({ offset: this.offset }, null, 2)}\n`,
      "utf8",
    );
  }
}
