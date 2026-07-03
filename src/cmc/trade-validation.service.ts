import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { CmcCryptoCurrency } from "./cmc.types";
import { TradeSettingsService } from "./trade-settings.service";
import { TradeSettings, TradeValidationResult } from "./trade-validation.types";

type SupportedChain = "solana" | "ethereum";

interface TradeTokenInfo {
  chain: SupportedChain;
  tokenAddress: string;
  explorerUrl: string;
  nativeSymbol: "SOL" | "ETH";
  requestedAmount: number;
  walletAddress: string;
  allowedDexIds: string[];
}

interface CmcDetailResponse {
  data?: {
    urls?: {
      explorer?: string[];
    };
    platforms?: CmcPlatform[];
  };
}

interface CmcPlatform {
  contractAddress?: string;
  contractPlatform?: string;
  contractChainId?: number;
  contractExplorerUrl?: string;
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

interface JsonRpcBalanceResponse {
  result?: {
    value?: number;
  } | string;
  error?: {
    message?: string;
  };
}

interface RugCheckSummaryResponse {
  risks?: RugCheckRisk[];
  score_normalised?: number;
  lpLockedPct?: number;
}

interface RugCheckRisk {
  name?: string;
  value?: string;
  description?: string;
  level?: string;
}

interface HoneypotResponse {
  summary?: {
    risk?: string;
    riskLevel?: number;
    flags?: { flag?: string; severity?: string; description?: string }[];
  };
  honeypotResult?: {
    isHoneypot?: boolean;
    honeypotReason?: string;
  };
  holderAnalysis?: {
    holders?: string;
    failed?: string;
    successful?: string;
  };
  contractCode?: {
    openSource?: boolean;
  };
}

interface GoPlusResponse {
  result?: Record<
    string,
    {
      cannot_sell_all?: string;
      is_open_source?: string;
      is_honeypot?: string;
      sell_tax?: string;
      buy_tax?: string;
      lp_holders?: { is_locked?: number | string }[];
    }
  >;
}

interface RiskResult {
  highRisk: boolean;
  summary: string;
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
      const tokenInfo = await this.findTradeTokenInfo(coin, settings);

      if (!tokenInfo) {
        return this.reject(
          settings,
          "قرارداد قابل بررسی روی شبکه‌های فعال پیدا نشد.",
        );
      }

      const dexResult = await this.findTrustedDex(tokenInfo, settings);

      if (!dexResult) {
        return this.reject(
          settings,
          "جفت معاملاتی معتبر با DEX مجاز و نقدینگی کافی پیدا نشد.",
          tokenInfo.tokenAddress,
          tokenInfo.explorerUrl,
          tokenInfo.chain,
        );
      }

      const riskResult = await this.checkRisk(tokenInfo);
      const priceChange1h = this.getOneHourPriceChange(coin);
      const autoBuyThreshold = -Math.abs(settings.autoBuyDropThresholdPercent);

      if (riskResult.highRisk) {
        if (!settings.showHighRiskAlerts) {
          return this.reject(
            settings,
            `ریسک ${this.formatChain(tokenInfo.chain)} قابل قبول نبود: ${riskResult.summary}`,
            tokenInfo.tokenAddress,
            tokenInfo.explorerUrl,
            tokenInfo.chain,
          );
        }

        return this.result({
          decision: "high_risk",
          reason: `کوین روی ${this.formatChain(tokenInfo.chain)} است، اما ریسک قفل یا ریسک امنیتی دارد؛ فقط نمایش داده می‌شود.`,
          tokenInfo,
          dexResult,
          riskResult,
          priceChange1h,
          autoBuyThreshold,
          settings,
        });
      }

      const meetsAutoBuyDrop =
        priceChange1h !== undefined && priceChange1h <= autoBuyThreshold;

      if (!meetsAutoBuyDrop) {
        return this.result({
          decision: "review",
          reason: `قابل بررسی برای خرید است، اما افت یک‌ساعته هنوز به آستانه خرید خودکار ${autoBuyThreshold}% نرسیده است.`,
          tokenInfo,
          dexResult,
          riskResult,
          priceChange1h,
          autoBuyThreshold,
          settings,
        });
      }

      const walletNativeBalance = await this.fetchWalletBalance(tokenInfo);
      const hasBalance = walletNativeBalance >= tokenInfo.requestedAmount;

      return this.result({
        decision: hasBalance ? "auto_buy" : "review",
        reason: hasBalance
          ? "مجاز برای خرید خودکار است و خرید در حالت dry-run ثبت شد."
          : `قابل بررسی برای خرید است، اما موجودی ${tokenInfo.nativeSymbol} برای خرید خودکار کافی نیست.`,
        tokenInfo,
        dexResult,
        riskResult,
        priceChange1h,
        autoBuyThreshold,
        settings,
        walletNativeBalance,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Trade validation failed for ${coin.slug}: ${message}`);
      return this.reject(settings, `خطای بررسی مرحله دوم: ${message}`);
    }
  }

  formatResult(result: TradeValidationResult): string {
    return [
      "نتیجه مرحله دوم خرید تست",
      `وضعیت: ${this.formatStatus(result)}`,
      `دسته: ${this.formatDecision(result.decision)}`,
      `دلیل: ${result.reason}`,
      `شبکه: ${result.chain ?? "n/a"}`,
      `آدرس توکن: ${result.tokenAddress ?? "n/a"}`,
      `لینک explorer: ${result.explorerUrl ?? "n/a"}`,
      `صرافی معتبر: ${result.dexId ?? "n/a"}`,
      `لینک pair: ${result.pairUrl ?? "n/a"}`,
      `نقدینگی دلاری: ${result.liquidityUsd ?? "n/a"}`,
      `ریسک شبکه: ${result.riskSummary ?? "n/a"}`,
      `افت یک‌ساعته: ${
        result.priceChange1hPercent === undefined
          ? "n/a"
          : `${result.priceChange1hPercent.toFixed(2)}%`
      }`,
      `آستانه خرید خودکار: ${
        result.autoBuyDropThresholdPercent === undefined
          ? "n/a"
          : `${result.autoBuyDropThresholdPercent}%`
      }`,
      `موجودی ولت: ${result.walletNativeBalance ?? "n/a"} ${
        result.nativeSymbol ?? "n/a"
      }`,
      `مبلغ خرید تست: ${result.requestedNativeAmount ?? "n/a"} ${
        result.nativeSymbol ?? "n/a"
      }`,
      `حالت خرید: ${result.dryRun ? "dry-run" : "live"}`,
    ].join("\n");
  }

  private result(input: {
    decision: "high_risk" | "review" | "auto_buy";
    reason: string;
    tokenInfo: TradeTokenInfo;
    dexResult: DexScreenerPair;
    riskResult: RiskResult;
    priceChange1h: number | undefined;
    autoBuyThreshold: number;
    settings: TradeSettings;
    walletNativeBalance?: number;
  }): TradeValidationResult {
    return {
      enabled: true,
      accepted: true,
      decision: input.decision,
      reason: input.reason,
      chain: input.tokenInfo.chain,
      tokenAddress: input.tokenInfo.tokenAddress,
      explorerUrl: input.tokenInfo.explorerUrl,
      dexId: input.dexResult.dexId,
      pairUrl: input.dexResult.url,
      liquidityUsd: input.dexResult.liquidity?.usd,
      riskSummary: input.riskResult.summary,
      priceChange1hPercent: input.priceChange1h,
      autoBuyDropThresholdPercent: input.autoBuyThreshold,
      nativeSymbol: input.tokenInfo.nativeSymbol,
      walletNativeBalance: input.walletNativeBalance,
      requestedNativeAmount: input.tokenInfo.requestedAmount,
      walletSolBalance:
        input.tokenInfo.chain === "solana" ? input.walletNativeBalance : undefined,
      requestedSolAmount:
        input.tokenInfo.chain === "solana" ? input.tokenInfo.requestedAmount : undefined,
      dryRun: true,
    };
  }

  private formatStatus(result: TradeValidationResult): string {
    if (result.decision === "high_risk") {
      return "فقط نمایش";
    }

    return result.accepted ? "قبول" : "رد";
  }

  private formatDecision(decision: TradeValidationResult["decision"]): string {
    const labels: Record<TradeValidationResult["decision"], string> = {
      disabled: "غیرفعال",
      rejected: "رد شده",
      high_risk: "پرریسک، فقط نمایش",
      review: "قابل بررسی برای خرید",
      auto_buy: "مجاز برای خرید خودکار",
    };

    return labels[decision];
  }

  private async findTradeTokenInfo(
    coin: CmcCryptoCurrency,
    settings: TradeSettings,
  ): Promise<TradeTokenInfo | null> {
    const enabledChains = new Set(
      settings.enabledChains.map((chain) => chain.toLowerCase()),
    );

    if (coin.source === "CoinGecko") {
      const detail = await this.fetchCoinGeckoDetail(coin);

      return this.findCoinGeckoTokenInfo(detail, settings, enabledChains);
    }

    const detail = await this.fetchCmcDetail(coin);
    return this.findCmcTokenInfo(detail, settings, enabledChains);
  }

  private async fetchCmcDetail(
    coin: CmcCryptoCurrency,
  ): Promise<CmcDetailResponse> {
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

    return response.data;
  }

  private async fetchCoinGeckoDetail(
    coin: CmcCryptoCurrency,
  ): Promise<CoinGeckoDetailResponse> {
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

    return response.data;
  }

  private findCmcTokenInfo(
    detail: CmcDetailResponse,
    settings: TradeSettings,
    enabledChains: Set<string>,
  ): TradeTokenInfo | null {
    if (enabledChains.has("solana")) {
      const explorerUrl =
        detail.data?.urls?.explorer?.find((url) =>
          this.extractSolanaTokenAddress(url),
        ) ??
        this.getCmcPlatformExplorer(detail, "solana");
      const tokenAddress = explorerUrl
        ? this.extractSolanaTokenAddress(explorerUrl)
        : null;

      if (explorerUrl && tokenAddress) {
        return this.createTokenInfo("solana", tokenAddress, explorerUrl, settings);
      }
    }

    if (enabledChains.has("ethereum")) {
      const platform = detail.data?.platforms?.find(
        (item) =>
          item.contractChainId === 1 ||
          item.contractPlatform?.toLowerCase() === "ethereum",
      );
      const explorerUrl =
        platform?.contractExplorerUrl ??
        detail.data?.urls?.explorer?.find((url) =>
          this.extractEthereumTokenAddress(url),
        );
      const tokenAddress =
        platform?.contractAddress ??
        (explorerUrl ? this.extractEthereumTokenAddress(explorerUrl) : null);

      if (tokenAddress) {
        return this.createTokenInfo(
          "ethereum",
          tokenAddress,
          explorerUrl ?? `https://etherscan.io/token/${tokenAddress}`,
          settings,
        );
      }
    }

    return null;
  }

  private findCoinGeckoTokenInfo(
    detail: CoinGeckoDetailResponse,
    settings: TradeSettings,
    enabledChains: Set<string>,
  ): TradeTokenInfo | null {
    if (enabledChains.has("solana")) {
      const solanaMint = detail.platforms?.solana;

      if (solanaMint) {
        return this.createTokenInfo(
          "solana",
          solanaMint,
          `https://solscan.io/token/${solanaMint}`,
          settings,
        );
      }

      const explorerUrl = detail.links?.blockchain_site?.find((url) =>
        this.extractSolanaTokenAddress(url),
      );
      const tokenAddress = explorerUrl
        ? this.extractSolanaTokenAddress(explorerUrl)
        : null;

      if (explorerUrl && tokenAddress) {
        return this.createTokenInfo("solana", tokenAddress, explorerUrl, settings);
      }
    }

    if (enabledChains.has("ethereum")) {
      const ethereumAddress = detail.platforms?.ethereum;

      if (ethereumAddress) {
        return this.createTokenInfo(
          "ethereum",
          ethereumAddress,
          `https://etherscan.io/token/${ethereumAddress}`,
          settings,
        );
      }
    }

    return null;
  }

  private getCmcPlatformExplorer(
    detail: CmcDetailResponse,
    platformName: string,
  ): string | null {
    const platform = detail.data?.platforms?.find(
      (item) => item.contractPlatform?.toLowerCase() === platformName,
    );

    return platform?.contractExplorerUrl ?? null;
  }

  private createTokenInfo(
    chain: SupportedChain,
    tokenAddress: string,
    explorerUrl: string,
    settings: TradeSettings,
  ): TradeTokenInfo {
    if (chain === "ethereum") {
      return {
        chain,
        tokenAddress,
        explorerUrl,
        nativeSymbol: "ETH",
        requestedAmount: settings.ethAmount,
        walletAddress: settings.ethWalletAddress,
        allowedDexIds: settings.allowedEthereumDexIds,
      };
    }

    return {
      chain,
      tokenAddress,
      explorerUrl,
      nativeSymbol: "SOL",
      requestedAmount: settings.solAmount,
      walletAddress: settings.walletAddress,
      allowedDexIds: settings.allowedSolanaDexIds,
    };
  }

  private extractSolanaTokenAddress(url: string): string | null {
    const match = url.match(
      /(?:solscan\.io\/token\/|solana\.fm\/address\/|explorer\.solana\.com\/address\/)([1-9A-HJ-NP-Za-km-z]{32,44})/,
    );

    return match?.[1] ?? null;
  }

  private extractEthereumTokenAddress(url: string): string | null {
    const match = url.match(/0x[a-fA-F0-9]{40}/);
    return match?.[0] ?? null;
  }

  private async findTrustedDex(
    tokenInfo: TradeTokenInfo,
    settings: TradeSettings,
  ): Promise<DexScreenerPair | null> {
    const response = await firstValueFrom(
      this.httpService.get<DexScreenerResponse>(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenInfo.tokenAddress}`,
        {
          timeout: 20000,
        },
      ),
    );

    const allowedDexIds = new Set(
      tokenInfo.allowedDexIds.map((dexId) => dexId.toLowerCase()),
    );

    return (
      (response.data.pairs ?? [])
        .filter((pair) => pair.chainId === tokenInfo.chain)
        .filter((pair) => allowedDexIds.has((pair.dexId ?? "").toLowerCase()))
        .filter((pair) => (pair.liquidity?.usd ?? 0) >= settings.minLiquidityUsd)
        .sort((first, second) => (second.liquidity?.usd ?? 0) - (first.liquidity?.usd ?? 0))[0] ??
      null
    );
  }

  private async fetchWalletBalance(tokenInfo: TradeTokenInfo): Promise<number> {
    if (!tokenInfo.walletAddress) {
      return 0;
    }

    if (tokenInfo.chain === "ethereum") {
      return this.fetchEthereumBalance(tokenInfo.walletAddress);
    }

    return this.fetchSolanaBalance(tokenInfo.walletAddress);
  }

  private async fetchSolanaBalance(walletAddress: string): Promise<number> {
    const response = await firstValueFrom(
      this.httpService.post<JsonRpcBalanceResponse>(
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

    const result = response.data.result;
    return typeof result === "object" ? (result.value ?? 0) / 1_000_000_000 : 0;
  }

  private async fetchEthereumBalance(walletAddress: string): Promise<number> {
    const response = await firstValueFrom(
      this.httpService.post<JsonRpcBalanceResponse>(
        this.configService.get<string>("ETH_RPC_URL") ??
          "https://cloudflare-eth.com",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [walletAddress, "latest"],
        },
        {
          timeout: 20000,
        },
      ),
    );

    if (response.data.error?.message) {
      throw new Error(response.data.error.message);
    }

    const result = response.data.result;
    return typeof result === "string" ? Number(BigInt(result)) / 1e18 : 0;
  }

  private getOneHourPriceChange(coin: CmcCryptoCurrency): number | undefined {
    return coin.quotes?.find((quote) => quote.name === "USD")?.percentChange1h;
  }

  private async checkRisk(tokenInfo: TradeTokenInfo): Promise<RiskResult> {
    if (tokenInfo.chain === "ethereum") {
      return this.checkEthereumRisk(tokenInfo.tokenAddress);
    }

    return this.checkSolanaRisk(tokenInfo.tokenAddress);
  }

  private async checkSolanaRisk(tokenAddress: string): Promise<RiskResult> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<RugCheckSummaryResponse>(
          `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`,
          {
            timeout: 20000,
          },
        ),
      );
      const risks = response.data.risks ?? [];
      const riskyItems = risks.filter((risk) => this.isHighRiskItem(risk));
      const riskText = risks.length
        ? risks
            .map((risk) =>
              [risk.name, risk.value, risk.level].filter(Boolean).join(" / "),
            )
            .join(" | ")
        : "ریسک جدی از RugCheck گزارش نشد.";
      const lowLpLock =
        response.data.lpLockedPct !== undefined && response.data.lpLockedPct < 50;
      const highScore =
        response.data.score_normalised !== undefined &&
        response.data.score_normalised >= 60;

      return {
        highRisk: Boolean(riskyItems.length || lowLpLock || highScore),
        summary: riskText,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        highRisk: true,
        summary: `بررسی ریسک سولانا ناموفق بود: ${message}`,
      };
    }
  }

  private async checkEthereumRisk(tokenAddress: string): Promise<RiskResult> {
    const parts: string[] = [];
    let highRisk = false;

    try {
      const response = await firstValueFrom(
        this.httpService.get<HoneypotResponse>(
          "https://api.honeypot.is/v2/IsHoneypot",
          {
            params: {
              address: tokenAddress,
              chainID: 1,
            },
            timeout: 20000,
          },
        ),
      );
      const flags = response.data.summary?.flags ?? [];
      const failed = Number(response.data.holderAnalysis?.failed ?? 0);
      const holders = Number(response.data.holderAnalysis?.holders ?? 0);
      const failureRatio = holders ? failed / holders : 0;

      highRisk =
        highRisk ||
        Boolean(response.data.honeypotResult?.isHoneypot) ||
        failureRatio >= 0.25 ||
        flags.some((flag) =>
          ["critical", "high"].includes((flag.severity ?? "").toLowerCase()),
        ) ||
        response.data.contractCode?.openSource === false;
      parts.push(
        [
          `Honeypot risk=${response.data.summary?.risk ?? "n/a"}`,
          `isHoneypot=${response.data.honeypotResult?.isHoneypot ?? "n/a"}`,
          `failedSells=${failed}/${holders || "n/a"}`,
          `openSource=${response.data.contractCode?.openSource ?? "n/a"}`,
        ].join(", "),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      highRisk = true;
      parts.push(`Honeypot check failed: ${message}`);
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<GoPlusResponse>(
          "https://api.gopluslabs.io/api/v1/token_security/1",
          {
            params: {
              contract_addresses: tokenAddress,
            },
            timeout: 20000,
          },
        ),
      );
      const security =
        response.data.result?.[tokenAddress.toLowerCase()] ??
        response.data.result?.[tokenAddress];
      const unlockedLp =
        security?.lp_holders?.some((holder) => String(holder.is_locked) !== "1") ??
        false;

      highRisk =
        highRisk ||
        security?.cannot_sell_all === "1" ||
        security?.is_honeypot === "1" ||
        security?.is_open_source === "0" ||
        unlockedLp;
      parts.push(
        [
          `GoPlus cannotSellAll=${security?.cannot_sell_all ?? "n/a"}`,
          `honeypot=${security?.is_honeypot ?? "n/a"}`,
          `openSource=${security?.is_open_source ?? "n/a"}`,
          `unlockedLp=${unlockedLp}`,
        ].join(", "),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      highRisk = true;
      parts.push(`GoPlus check failed: ${message}`);
    }

    return {
      highRisk,
      summary: parts.join(" | "),
    };
  }

  private isHighRiskItem(risk: RugCheckRisk): boolean {
    const name = (risk.name ?? "").toLowerCase();
    const description = (risk.description ?? "").toLowerCase();
    const level = (risk.level ?? "").toLowerCase();
    const text = `${name} ${description}`;

    return (
      ["danger", "critical", "high"].includes(level) ||
      text.includes("freeze") ||
      text.includes("mint authority") ||
      text.includes("non-transferable") ||
      text.includes("permanent delegate") ||
      text.includes("transfer fee") ||
      text.includes("single holder") ||
      text.includes("high holder concentration")
    );
  }

  private formatChain(chain: SupportedChain): string {
    return chain === "ethereum" ? "اتریوم" : "سولانا";
  }

  private reject(
    settings: TradeSettings,
    reason: string,
    tokenAddress?: string,
    explorerUrl?: string,
    chain?: SupportedChain,
  ): TradeValidationResult {
    return {
      enabled: true,
      accepted: false,
      decision: "rejected",
      reason,
      chain,
      tokenAddress,
      explorerUrl,
      requestedNativeAmount: chain === "ethereum" ? settings.ethAmount : settings.solAmount,
      nativeSymbol: chain === "ethereum" ? "ETH" : chain === "solana" ? "SOL" : undefined,
      dryRun: true,
    };
  }
}
