import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { CmcCryptoCurrency } from "./cmc.types";
import { TradeSettingsService } from "./trade-settings.service";
import { TradeSettings, TradeValidationResult } from "./trade-validation.types";

interface CmcDetailResponse {
  data?: {
    urls?: {
      explorer?: string[];
    };
  };
}

interface CoinGeckoDetailResponse {
  asset_platform_id?: string;
  platforms?: Record<string, string | null | undefined>;
  links?: {
    blockchain_site?: string[];
  };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

interface DexScreenerPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  liquidity?: {
    usd?: number;
  };
}

interface SolanaBalanceResponse {
  result?: {
    value?: number;
  };
  error?: {
    message?: string;
  };
}

@Injectable()
export class TradeValidationService {
  private readonly logger = new Logger(TradeValidationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly tradeSettingsService: TradeSettingsService,
  ) {}

  async validate(coin: CmcCryptoCurrency): Promise<TradeValidationResult> {
    const settings = this.tradeSettingsService.getSettings();

    if (!settings.enabled) {
      return {
        enabled: false,
        accepted: false,
        decision: "disabled",
        reason: "بررسی خرید تست غیرفعال است.",
        dryRun: true,
      };
    }

    try {
      const explorerUrl = await this.findSolanaExplorerUrl(coin);

      if (!explorerUrl) {
        return this.reject(
          settings,
          "لینک یا platform سولانا در منبع کوین پیدا نشد.",
        );
      }

      const tokenAddress = this.extractSolanaTokenAddress(explorerUrl);

      if (!tokenAddress) {
        return this.reject(settings, "آدرس mint سولانا از explorer قابل استخراج نبود.");
      }

      const dexResult = await this.findTrustedSolanaDex(tokenAddress, settings);

      if (!dexResult) {
        return this.reject(
          settings,
          "جفت معاملاتی معتبر با DEX مجاز و نقدینگی کافی پیدا نشد.",
          tokenAddress,
          explorerUrl,
        );
      }

      const walletSolBalance = await this.fetchWalletBalance(settings.walletAddress);
      const hasBalance = walletSolBalance >= settings.solAmount;
      const decision = hasBalance ? "auto_buy" : "review";
      const reason = hasBalance
        ? "مجاز برای خرید خودکار است و خرید در حالت dry-run ثبت شد."
        : "قابل بررسی برای خرید است، اما موجودی SOL برای خرید خودکار کافی نیست.";

      return {
        enabled: true,
        accepted: true,
        decision,
        reason,
        chain: "solana",
        tokenAddress,
        explorerUrl,
        dexId: dexResult.dexId,
        pairUrl: dexResult.url,
        liquidityUsd: dexResult.liquidity?.usd,
        walletSolBalance,
        requestedSolAmount: settings.solAmount,
        dryRun: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Trade validation failed for ${coin.slug}: ${message}`);
      return this.reject(settings, `خطای بررسی مرحله دوم: ${message}`);
    }
  }

  formatResult(result: TradeValidationResult): string {
    return [
      "نتیجه مرحله دوم خرید تست",
      `وضعیت: ${result.accepted ? "قبول" : "رد"}`,
      `دسته: ${this.formatDecision(result.decision)}`,
      `دلیل: ${result.reason}`,
      `شبکه: ${result.chain ?? "n/a"}`,
      `آدرس توکن: ${result.tokenAddress ?? "n/a"}`,
      `لینک explorer: ${result.explorerUrl ?? "n/a"}`,
      `صرافی معتبر: ${result.dexId ?? "n/a"}`,
      `لینک pair: ${result.pairUrl ?? "n/a"}`,
      `نقدینگی دلاری: ${result.liquidityUsd ?? "n/a"}`,
      `موجودی ولت: ${result.walletSolBalance ?? "n/a"} SOL`,
      `مبلغ خرید تست: ${result.requestedSolAmount ?? "n/a"} SOL`,
      `حالت خرید: ${result.dryRun ? "dry-run" : "live"}`,
    ].join("\n");
  }

  private formatDecision(decision: TradeValidationResult["decision"]): string {
    const labels: Record<TradeValidationResult["decision"], string> = {
      disabled: "غیرفعال",
      rejected: "رد شده",
      review: "قابل بررسی برای خرید",
      auto_buy: "مجاز برای خرید خودکار",
    };

    return labels[decision];
  }

  private async findSolanaExplorerUrl(
    coin: CmcCryptoCurrency,
  ): Promise<string | null> {
    if (coin.source === "CoinGecko") {
      return this.findCoinGeckoSolanaExplorerUrl(coin);
    }

    return this.findCmcSolanaExplorerUrl(coin);
  }

  private async findCmcSolanaExplorerUrl(
    coin: CmcCryptoCurrency,
  ): Promise<string | null> {
    const response = await firstValueFrom(
      this.httpService.get<CmcDetailResponse>(
        "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail",
        {
          params: {
            slug: coin.slug,
          },
          headers: {
            accept: "application/json, text/plain, */*",
            origin: "https://coinmarketcap.com",
            referer: "https://coinmarketcap.com/",
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
          },
          timeout: 20000,
        },
      ),
    );

    return (
      response.data.data?.urls?.explorer?.find((url) =>
        this.extractSolanaTokenAddress(url),
      ) ?? null
    );
  }

  private async findCoinGeckoSolanaExplorerUrl(
    coin: CmcCryptoCurrency,
  ): Promise<string | null> {
    const response = await firstValueFrom(
      this.httpService.get<CoinGeckoDetailResponse>(
        `https://api.coingecko.com/api/v3/coins/${coin.slug}`,
        {
          params: {
            localization: "false",
            tickers: "false",
            market_data: "false",
            community_data: "false",
            developer_data: "false",
            sparkline: "false",
          },
          headers: {
            accept: "application/json",
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
          },
          timeout: 20000,
        },
      ),
    );

    const solanaMint = response.data.platforms?.solana;

    if (solanaMint) {
      return `https://solscan.io/token/${solanaMint}`;
    }

    return (
      response.data.links?.blockchain_site?.find((url) =>
        this.extractSolanaTokenAddress(url),
      ) ?? null
    );
  }

  private extractSolanaTokenAddress(url: string): string | null {
    const match = url.match(
      /(?:solscan\.io\/token\/|solana\.fm\/address\/|explorer\.solana\.com\/address\/)([1-9A-HJ-NP-Za-km-z]{32,44})/,
    );

    return match?.[1] ?? null;
  }

  private async findTrustedSolanaDex(
    tokenAddress: string,
    settings: TradeSettings,
  ): Promise<DexScreenerPair | null> {
    const response = await firstValueFrom(
      this.httpService.get<DexScreenerResponse>(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
        {
          timeout: 20000,
        },
      ),
    );

    const allowedDexIds = new Set(
      settings.allowedSolanaDexIds.map((dexId) => dexId.toLowerCase()),
    );

    return (
      (response.data.pairs ?? [])
        .filter((pair) => pair.chainId === "solana")
        .filter((pair) => allowedDexIds.has((pair.dexId ?? "").toLowerCase()))
        .filter((pair) => (pair.liquidity?.usd ?? 0) >= settings.minLiquidityUsd)
        .sort((first, second) => (second.liquidity?.usd ?? 0) - (first.liquidity?.usd ?? 0))[0] ??
      null
    );
  }

  private async fetchWalletBalance(walletAddress: string): Promise<number> {
    if (!walletAddress) {
      return 0;
    }

    const response = await firstValueFrom(
      this.httpService.post<SolanaBalanceResponse>(
        this.configService.get<string>("SOLANA_RPC_URL") ??
          "https://api.mainnet-beta.solana.com",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getBalance",
          params: [walletAddress],
        },
        {
          timeout: 20000,
        },
      ),
    );

    if (response.data.error?.message) {
      throw new Error(response.data.error.message);
    }

    return (response.data.result?.value ?? 0) / 1_000_000_000;
  }

  private reject(
    settings: TradeSettings,
    reason: string,
    tokenAddress?: string,
    explorerUrl?: string,
  ): TradeValidationResult {
    return {
      enabled: true,
      accepted: false,
      decision: "rejected",
      reason,
      chain: settings.solanaOnly ? "solana" : undefined,
      tokenAddress,
      explorerUrl,
      requestedSolAmount: settings.solAmount,
      dryRun: true,
    };
  }
}
