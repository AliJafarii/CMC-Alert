import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TelegramSubscriber } from "./subscriber.types";

@Injectable()
export class SubscriberRepositoryService {
  private readonly logger = new Logger(SubscriberRepositoryService.name);
  private readonly filePath = join(process.cwd(), "data", "subscribers.json");
  private subscribers = new Map<string, TelegramSubscriber>();

  constructor(private readonly configService: ConfigService) {
    this.load();
    this.seedDefaultSubscriber();
  }

  all(): TelegramSubscriber[] {
    return [...this.subscribers.values()];
  }

  count(): number {
    return this.subscribers.size;
  }

  upsert(input: {
    chatId: string;
    firstName?: string;
    username?: string;
  }): TelegramSubscriber {
    const now = new Date().toISOString();
    const existing = this.subscribers.get(input.chatId);
    const subscriber: TelegramSubscriber = {
      chatId: input.chatId,
      firstName: input.firstName ?? existing?.firstName,
      username: input.username ?? existing?.username,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.subscribers.set(input.chatId, subscriber);
    this.save();

    return subscriber;
  }

  remove(chatId: string): boolean {
    const removed = this.subscribers.delete(chatId);

    if (removed) {
      this.save();
    }

    return removed;
  }

  private load(): void {
    try {
      const file = readFileSync(this.filePath, "utf8");
      const subscribers = JSON.parse(file) as TelegramSubscriber[];
      this.subscribers = new Map(
        subscribers.map((subscriber) => [subscriber.chatId, subscriber]),
      );
    } catch {
      this.subscribers = new Map();
    }
  }

  private seedDefaultSubscriber(): void {
    const chatId = this.configService.get<string>("TELEGRAM_CHAT_ID");

    if (!chatId || this.subscribers.has(chatId)) {
      return;
    }

    this.upsert({ chatId });
    this.logger.log(`Seeded default Telegram subscriber ${chatId}`);
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;

    writeFileSync(tempPath, `${JSON.stringify(this.all(), null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}
