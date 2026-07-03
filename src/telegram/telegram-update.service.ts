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

interface AnomalyStateEntry {
  checkedAt?: string;
  isAnomalous?: boolean;
  source?: string;
  coinId?: string | number;
  name?: string;
  symbol?: string;
  slug?: string;
  reason?: string;
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
      );
      return;
    }

    if (text.startsWith("/anomalies")) {
      await this.handleAnomaliesCommand(chatId, text);
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
        ].join("\n"),
      ),
    ];

    await this.sendLongText(chatId, lines.join("\n\n"));
  }

  private async sendText(chatId: string, text: string): Promise<void> {
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
    const adminChatIds = (
      this.configService.get<string>("TELEGRAM_ADMIN_CHAT_IDS") ??
      this.configService.get<string>("TELEGRAM_ADMIN_CHAT_ID") ??
      this.configService.get<string>("TELEGRAM_CHAT_ID") ??
      ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    return adminChatIds.includes(chatId);
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
