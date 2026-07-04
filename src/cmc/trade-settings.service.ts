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
import { TradeSettings } from "./trade-validation.types";

@Injectable()
export class TradeSettingsService {
  private readonly logger = new Logger(TradeSettingsService.name);
  private readonly filePath = join(
    process.cwd(),
    "data",
    "trade-settings.json",
  );

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
    };

    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;

    writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);

    return settings;
  }

  formatSettings(settings = this.getSettings()): string {
    return [
      `وضعیت بررسی خرید تست: ${settings.enabled ? "فعال" : "غیرفعال"}`,
      `حالت اجرا: ${settings.mode}`,
      `روش اجرا: ${settings.executionStrategy}`,
      `لینک خرید دستی: ${settings.manualBuyLinksEnabled ? "فعال" : "غیرفعال"}`,
      `مبلغ هر خرید: ${settings.solAmount} SOL`,
      `مبلغ هر خرید اتریوم: ${settings.ethAmount} ETH`,
      `ولیت: ${settings.walletAddress || "تنظیم نشده"}`,
      `ولت اتریوم: ${settings.ethWalletAddress || "تنظیم نشده"}`,
      `حداقل نقدینگی: ${settings.minLiquidityUsd} دلار`,
      `حداقل حجم یک‌ساعته DEX: ${settings.minDexVolumeH1Usd} دلار`,
      `حداقل تعداد معامله یک‌ساعته DEX: ${settings.minDexTxnsH1}`,
      `آستانه تایید ریزش DEX: ${settings.dexDropThresholdPercent}%`,
      `شبکه‌های فعال: ${settings.enabledChains.join(", ")}`,
      `نمایش موارد پرریسک: ${settings.showHighRiskAlerts ? "فعال" : "غیرفعال"}`,
      `آستانه خرید خودکار: ${-Math.abs(settings.autoBuyDropThresholdPercent)}%`,
      `DEXهای مجاز سولانا: ${settings.allowedSolanaDexIds.join(", ")}`,
      `DEXهای مجاز اتریوم: ${settings.allowedEthereumDexIds.join(", ")}`,
    ].join("\n");
  }

  private getDefaultSettings(): TradeSettings {
    return {
      enabled: this.getBoolean("TRADE_VALIDATION_ENABLED", false),
      mode: this.getMode("TRADE_MODE", "dry-run"),
      executionStrategy: this.getExecutionStrategy(
        "TRADE_EXECUTION_STRATEGY",
        "hot-wallet",
      ),
      manualBuyLinksEnabled: this.getBoolean(
        "TRADE_MANUAL_BUY_LINKS_ENABLED",
        false,
      ),
      solAmount: this.getNumber("TRADE_SOL_AMOUNT", 0.01, 0.001, 10),
      ethAmount: this.getNumber("TRADE_ETH_AMOUNT", 0.002, 0.0001, 10),
      walletAddress:
        this.configService.get<string>("SOLANA_WALLET_ADDRESS") ?? "",
      ethWalletAddress:
        this.configService.get<string>("ETH_WALLET_ADDRESS") ?? "",
      solanaOnly: this.getBoolean("TRADE_SOLANA_ONLY", true),
      enabledChains: this.getList("TRADE_ENABLED_CHAINS", [
        "solana",
        "ethereum",
      ]),
      minLiquidityUsd: this.getNumber(
        "TRADE_MIN_LIQUIDITY_USD",
        1000,
        0,
        1_000_000,
      ),
      minDexVolumeH1Usd: this.getNumber(
        "TRADE_MIN_DEX_VOLUME_H1_USD",
        1000,
        0,
        1_000_000,
      ),
      minDexTxnsH1: this.getNumber("TRADE_MIN_DEX_TXNS_H1", 20, 0, 1_000),
      dexDropThresholdPercent: -Math.abs(
        this.getNumber("TRADE_DEX_DROP_THRESHOLD_PERCENT", 70, 1, 99),
      ),
      showHighRiskAlerts: this.getBoolean("TRADE_SHOW_HIGH_RISK_ALERTS", true),
      autoBuyDropThresholdPercent: this.getNumber(
        "TRADE_AUTO_BUY_DROP_THRESHOLD_PERCENT",
        80,
        1,
        99,
      ),
      allowedSolanaDexIds: this.getList("TRADE_ALLOWED_SOLANA_DEX_IDS", [
        "raydium",
        "orca",
        "meteora",
        "pumpswap",
        "pancakeswap",
        "lifinity",
        "jupiter-studio",
      ]),
      allowedEthereumDexIds: this.getList("TRADE_ALLOWED_ETHEREUM_DEX_IDS", [
        "uniswap",
        "sushiswap",
        "curve",
        "balancer",
        "pancakeswap",
        "shibaswap",
      ]),
    };
  }

  private loadOverrides(): Partial<TradeSettings> {
    if (!existsSync(this.filePath)) {
      return {};
    }

    try {
      return JSON.parse(
        readFileSync(this.filePath, "utf8"),
      ) as Partial<TradeSettings>;
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

  private getNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(this.configService.get<string>(key) ?? fallback);

    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Math.min(Math.max(value, min), max);
  }

  private getMode(
    key: string,
    fallback: "dry-run" | "live",
  ): "dry-run" | "live" {
    const value = this.configService.get<string>(key);

    return value === "live" ? "live" : fallback;
  }

  private getExecutionStrategy(
    key: string,
    fallback: "hot-wallet" | "manual-link",
  ): "hot-wallet" | "manual-link" {
    const value = this.configService.get<string>(key);

    return value === "manual-link" ? "manual-link" : fallback;
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
