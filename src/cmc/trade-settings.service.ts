import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TradeSettings } from "./trade-validation.types";

@Injectable()
export class TradeSettingsService {
  private readonly logger = new Logger(TradeSettingsService.name);
  private readonly filePath = join(process.cwd(), "data", "trade-settings.json");

  constructor(private readonly configService: ConfigService) {}

  getSettings(): TradeSettings {
    return {
      ...this.getDefaultSettings(),
      ...this.loadOverrides(),
    };
  }

  updateSettings(input: Partial<TradeSettings>): TradeSettings {
    const settings = {
      ...this.getSettings(),
      ...input,
      mode: "dry-run" as const,
    };

    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    return settings;
  }

  formatSettings(settings = this.getSettings()): string {
    return [
      `وضعیت بررسی خرید تست: ${settings.enabled ? "فعال" : "غیرفعال"}`,
      `حالت اجرا: ${settings.mode}`,
      `مبلغ هر خرید: ${settings.solAmount} SOL`,
      `ولیت: ${settings.walletAddress || "تنظیم نشده"}`,
      `حداقل نقدینگی: ${settings.minLiquidityUsd} دلار`,
      `شبکه فعال: ${settings.solanaOnly ? "فقط Solana" : "چندشبکه‌ای"}`,
      `DEXهای مجاز سولانا: ${settings.allowedSolanaDexIds.join(", ")}`,
    ].join("\n");
  }

  private getDefaultSettings(): TradeSettings {
    return {
      enabled: this.getBoolean("TRADE_VALIDATION_ENABLED", false),
      mode: "dry-run",
      solAmount: this.getNumber("TRADE_SOL_AMOUNT", 0.01, 0.001, 10),
      walletAddress: this.configService.get<string>("SOLANA_WALLET_ADDRESS") ?? "",
      solanaOnly: this.getBoolean("TRADE_SOLANA_ONLY", true),
      minLiquidityUsd: this.getNumber("TRADE_MIN_LIQUIDITY_USD", 1000, 0, 1_000_000),
      allowedSolanaDexIds: this.getList("TRADE_ALLOWED_SOLANA_DEX_IDS", [
        "raydium",
        "orca",
        "meteora",
        "pumpswap",
        "pancakeswap",
        "lifinity",
        "jupiter-studio",
      ]),
    };
  }

  private loadOverrides(): Partial<TradeSettings> {
    if (!existsSync(this.filePath)) {
      return {};
    }

    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<TradeSettings>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to read trade settings: ${message}`);
      return {};
    }
  }

  private getBoolean(key: string, fallback: boolean): boolean {
    const value = this.configService.get<string>(key);

    if (value === undefined) {
      return fallback;
    }

    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }

  private getNumber(key: string, fallback: number, min: number, max: number): number {
    const value = Number(this.configService.get<string>(key) ?? fallback);

    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Math.min(Math.max(value, min), max);
  }

  private getList(key: string, fallback: string[]): string[] {
    const value = this.configService.get<string>(key);

    if (!value) {
      return fallback;
    }

    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
