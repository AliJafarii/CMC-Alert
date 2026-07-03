import { HttpService } from "@nestjs/axios";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { Connection, PublicKey } from "@solana/web3.js";
import { formatEther, JsonRpcProvider } from "ethers";
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
  mode?: "dry-run" | "live";
  executionStrategy?: "hot-wallet" | "manual-link";
  manualBuyLinksEnabled?: boolean;
  solAmount?: number;
  ethAmount?: number;
  walletAddress?: string;
  ethWalletAddress?: string;
  solanaOnly?: boolean;
  enabledChains?: string[];
  minLiquidityUsd?: number;
  showHighRiskAlerts?: boolean;
  autoBuyDropThresholdPercent?: number;
  allowedSolanaDexIds?: string[];
  allowedEthereumDexIds?: string[];
}

interface TradingHotWalletFile {
  solana?: {
    publicKey?: string;
  };
  ethereum?: {
    address?: string;
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
        ["موجودی هات ولت"],
        ["فعال‌سازی خرید تست", "توقف خرید تست"],
        ["فعال‌سازی خرید واقعی", "بازگشت به dry-run"],
        ["روش هات ولت", "روش لینک دستی"],
        ["فعال‌سازی لینک دستی", "توقف لینک دستی"],
        [
          "مبلغ خرید 0.002 سولانا",
          "مبلغ خرید 0.005 سولانا",
          "مبلغ خرید 0.01 سولانا",
        ],
        [
          "مبلغ خرید 0.05 سولانا",
          "مبلغ خرید 0.1 سولانا",
        ],
        [
          "مبلغ خرید 0.001 اتریوم",
          "مبلغ خرید 0.002 اتریوم",
          "مبلغ خرید 0.005 اتریوم",
        ],
        [
          "نقدینگی 500 دلار",
          "نقدینگی 1000 دلار",
          "نقدینگی 5000 دلار",
        ],
        ["نقدینگی 10000 دلار"],
        [
          "آستانه خرید -80 درصد",
          "آستانه خرید -85 درصد",
          "آستانه خرید -90 درصد",
        ],
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
      "موجودی هات ولت",
      "فعال‌سازی خرید تست",
      "توقف خرید تست",
      "فعال‌سازی خرید واقعی",
      "بازگشت به dry-run",
      "روش هات ولت",
      "روش لینک دستی",
      "فعال‌سازی لینک دستی",
      "توقف لینک دستی",
      "مبلغ خرید 0.002 سولانا",
      "مبلغ خرید 0.005 سولانا",
      "مبلغ خرید 0.01 سولانا",
      "مبلغ خرید 0.05 سولانا",
      "مبلغ خرید 0.1 سولانا",
      "مبلغ خرید 0.001 اتریوم",
      "مبلغ خرید 0.002 اتریوم",
      "مبلغ خرید 0.005 اتریوم",
      "نقدینگی 500 دلار",
      "نقدینگی 1000 دلار",
      "نقدینگی 5000 دلار",
      "نقدینگی 10000 دلار",
      "آستانه خرید -80 درصد",
      "آستانه خرید -85 درصد",
      "آستانه خرید -90 درصد",
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

    if (text === "موجودی هات ولت") {
      await this.sendText(
        chatId,
        await this.formatHotWalletBalances(),
        this.getAdminReplyMarkup(chatId),
      );
      return;
    }

    if (text === "فعال‌سازی خرید تست") {
      settings.enabled = true;
    }

    if (text === "توقف خرید تست") {
      settings.enabled = false;
    }

    if (text === "فعال‌سازی خرید واقعی") {
      settings.mode = "live";
    }

    if (text === "بازگشت به dry-run") {
      settings.mode = "dry-run";
    }

    if (text === "روش هات ولت") {
      settings.executionStrategy = "hot-wallet";
    }

    if (text === "روش لینک دستی") {
      settings.executionStrategy = "manual-link";
    }

    if (text === "فعال‌سازی لینک دستی") {
      settings.manualBuyLinksEnabled = true;
    }

    if (text === "توقف لینک دستی") {
      settings.manualBuyLinksEnabled = false;
    }

    const amountMatch = text.match(/مبلغ خرید ([0-9.]+) سولانا/);

    if (amountMatch) {
      settings.solAmount = Number(amountMatch[1]);
    }

    const ethAmountMatch = text.match(/مبلغ خرید ([0-9.]+) اتریوم/);

    if (ethAmountMatch) {
      settings.ethAmount = Number(ethAmountMatch[1]);
    }

    const liquidityMatch = text.match(/نقدینگی ([0-9.]+) دلار/);

    if (liquidityMatch) {
      settings.minLiquidityUsd = Number(liquidityMatch[1]);
    }

    const autoBuyThresholdMatch = text.match(/آستانه خرید -([0-9.]+) درصد/);

    if (autoBuyThresholdMatch) {
      settings.autoBuyDropThresholdPercent = Number(autoBuyThresholdMatch[1]);
    }

    settings.mode = settings.mode ?? "dry-run";
    settings.executionStrategy = settings.executionStrategy ?? "hot-wallet";
    settings.manualBuyLinksEnabled = settings.manualBuyLinksEnabled ?? false;
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
      executionStrategy: "hot-wallet",
      manualBuyLinksEnabled: false,
      solAmount: 0.01,
      ethAmount: 0.002,
      walletAddress: this.configService.get<string>("SOLANA_WALLET_ADDRESS") ?? "",
      ethWalletAddress: this.configService.get<string>("ETH_WALLET_ADDRESS") ?? "",
      solanaOnly: true,
      enabledChains: ["solana", "ethereum"],
      minLiquidityUsd: 1000,
      showHighRiskAlerts: true,
      autoBuyDropThresholdPercent: 80,
      allowedSolanaDexIds: [
        "raydium",
        "orca",
        "meteora",
        "pumpswap",
        "pancakeswap",
        "lifinity",
        "jupiter-studio",
      ],
      allowedEthereumDexIds: [
        "uniswap",
        "sushiswap",
        "curve",
        "balancer",
        "pancakeswap",
        "shibaswap",
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
      `روش اجرا: ${settings.executionStrategy ?? "hot-wallet"}`,
      `لینک خرید دستی: ${settings.manualBuyLinksEnabled ? "فعال" : "غیرفعال"}`,
      `مبلغ هر خرید: ${settings.solAmount ?? 0.01} SOL`,
      `مبلغ هر خرید اتریوم: ${settings.ethAmount ?? 0.002} ETH`,
      `ولیت: ${settings.walletAddress ?? "تنظیم نشده"}`,
      `ولت اتریوم: ${settings.ethWalletAddress || "تنظیم نشده"}`,
      `شبکه‌ها: ${(settings.enabledChains ?? ["solana", "ethereum"]).join(", ")}`,
      `حداقل نقدینگی: ${settings.minLiquidityUsd ?? 1000} دلار`,
      `نمایش موارد پرریسک: ${settings.showHighRiskAlerts ? "فعال" : "غیرفعال"}`,
      `آستانه خرید خودکار: -${settings.autoBuyDropThresholdPercent ?? 80}%`,
      `DEXهای مجاز سولانا: ${(settings.allowedSolanaDexIds ?? []).join(", ")}`,
      `DEXهای مجاز اتریوم: ${(settings.allowedEthereumDexIds ?? []).join(", ")}`,
    ].join("\n");
  }

  private async formatHotWalletBalances(): Promise<string> {
    const wallet = this.loadHotWallet();
    const solanaAddress = wallet.solana?.publicKey ?? "تنظیم نشده";
    const ethereumAddress = wallet.ethereum?.address ?? "تنظیم نشده";
    const solanaBalance =
      wallet.solana?.publicKey === undefined
        ? "n/a"
        : await this.getSolanaBalance(wallet.solana.publicKey);
    const ethereumBalance =
      wallet.ethereum?.address === undefined
        ? "n/a"
        : await this.getEthereumBalance(wallet.ethereum.address);

    return [
      "موجودی hot wallet تست",
      "",
      `آدرس سولانا: ${solanaAddress}`,
      `موجودی سولانا: ${solanaBalance} SOL`,
      "",
      `آدرس اتریوم: ${ethereumAddress}`,
      `موجودی اتریوم: ${ethereumBalance} ETH`,
    ].join("\n");
  }

  private loadHotWallet(): TradingHotWalletFile {
    const walletPath =
      this.configService.get<string>("TRADE_HOT_WALLET_PATH") ??
      join(process.cwd(), "secrets", "test-hot-wallet.json");

    if (!existsSync(walletPath)) {
      return {};
    }

    return JSON.parse(readFileSync(walletPath, "utf8")) as TradingHotWalletFile;
  }

  private async getSolanaBalance(publicKey: string): Promise<string> {
    try {
      const connection = new Connection(
        this.configService.get<string>("SOLANA_RPC_URL") ??
          "https://api.mainnet-beta.solana.com",
        "confirmed",
      );
      const lamports = await connection.getBalance(new PublicKey(publicKey));

      return String(lamports / 1_000_000_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `خطا: ${message}`;
    }
  }

  private async getEthereumBalance(address: string): Promise<string> {
    try {
      const provider = new JsonRpcProvider(
        this.configService.get<string>("ETH_RPC_URL") ??
          "https://ethereum-rpc.publicnode.com",
      );
      const wei = await provider.getBalance(address);

      return formatEther(wei);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `خطا: ${message}`;
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
