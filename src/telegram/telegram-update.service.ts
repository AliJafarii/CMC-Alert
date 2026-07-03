import { HttpService } from "@nestjs/axios";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

@Injectable()
export class TelegramUpdateService implements OnModuleInit {
  private readonly logger = new Logger(TelegramUpdateService.name);
  private readonly statePath = join(
    process.cwd(),
    "data",
    "telegram-state.json",
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
    }
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
