import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { CmcCryptoCurrency } from "./cmc.types";

type SupportedChain = "solana" | "ethereum";

interface TokenInfo {
  chain: SupportedChain;
  tokenAddress: string;
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
  baseToken?: {
    address?: string;
  };
  quoteToken?: {
    address?: string;
  };
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: {
    usd?: number;
  };
}

@Injectable()
export class DexMarketValidationService {
  private readonly logger = new Logger(DexMarketValidationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  async isValidMarketMove(coin: CmcCryptoCurrency): Promise<{
    accepted: boolean;
    reason: string;
  }> {
    try {
      const tokenInfo = await this.findTokenInfo(coin);

      if (!tokenInfo) {
        return {
          accepted: false,
          reason:
            "کوین نامعتبر شد: قرارداد قابل بررسی روی شبکه‌های فعال پیدا نشد.",
        };
      }

      const pair = await this.findTrustedPair(tokenInfo);

      if (!pair) {
        return {
          accepted: false,
          reason:
            "کوین نامعتبر شد: pair معتبر با contract دقیق، DEX مجاز و نقدینگی کافی پیدا نشد.",
        };
      }

      return this.validatePairMove(pair);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`DEX validation failed for ${coin.slug}: ${message}`);

      return {
        accepted: false,
        reason: `کوین نامعتبر شد: خطای تایید نوسان DEX: ${message}`,
      };
    }
  }

  private async findTokenInfo(
    coin: CmcCryptoCurrency,
  ): Promise<TokenInfo | null> {
    const enabledChains = new Set(this.getEnabledChains());

    if (coin.source === "CoinGecko") {
      const detail = await this.fetchCoinGeckoDetail(coin);
      return this.findCoinGeckoTokenInfo(detail, enabledChains);
    }

    const detail = await this.fetchCmcDetail(coin);
    return this.findCmcTokenInfo(detail, enabledChains);
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
    enabledChains: Set<string>,
  ): TokenInfo | null {
    if (enabledChains.has("solana")) {
      const explorerUrl =
        detail.data?.urls?.explorer?.find((url) =>
          this.extractSolanaTokenAddress(url),
        ) ?? this.getCmcPlatformExplorer(detail, "solana");
      const tokenAddress = explorerUrl
        ? this.extractSolanaTokenAddress(explorerUrl)
        : null;

      if (tokenAddress) {
        return {
          chain: "solana",
          tokenAddress,
        };
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
        return {
          chain: "ethereum",
          tokenAddress,
        };
      }
    }

    return null;
  }

  private findCoinGeckoTokenInfo(
    detail: CoinGeckoDetailResponse,
    enabledChains: Set<string>,
  ): TokenInfo | null {
    if (enabledChains.has("solana")) {
      const solanaMint = detail.platforms?.solana;

      if (solanaMint) {
        return {
          chain: "solana",
          tokenAddress: solanaMint,
        };
      }

      const explorerUrl = detail.links?.blockchain_site?.find((url) =>
        this.extractSolanaTokenAddress(url),
      );
      const tokenAddress = explorerUrl
        ? this.extractSolanaTokenAddress(explorerUrl)
        : null;

      if (tokenAddress) {
        return {
          chain: "solana",
          tokenAddress,
        };
      }
    }

    if (enabledChains.has("ethereum")) {
      const ethereumAddress = detail.platforms?.ethereum;

      if (ethereumAddress) {
        return {
          chain: "ethereum",
          tokenAddress: ethereumAddress,
        };
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

  private async findTrustedPair(
    tokenInfo: TokenInfo,
  ): Promise<DexScreenerPair | null> {
    const response = await firstValueFrom(
      this.httpService.get<DexScreenerResponse>(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenInfo.tokenAddress}`,
        {
          timeout: 20000,
        },
      ),
    );
    const allowedDexIds = new Set(this.getAllowedDexIds(tokenInfo.chain));

    return (
      (response.data.pairs ?? [])
        .filter((pair) => pair.chainId === tokenInfo.chain)
        .filter((pair) => allowedDexIds.has((pair.dexId ?? "").toLowerCase()))
        .filter((pair) => this.isPairForToken(pair, tokenInfo.tokenAddress))
        .filter(
          (pair) => (pair.liquidity?.usd ?? 0) >= this.getMinLiquidityUsd(),
        )
        .sort(
          (first, second) =>
            (second.liquidity?.usd ?? 0) - (first.liquidity?.usd ?? 0),
        )[0] ?? null
    );
  }

  private validatePairMove(pair: DexScreenerPair): {
    accepted: boolean;
    reason: string;
  } {
    const dexChange1h = pair.priceChange?.h1;
    const volumeH1 = pair.volume?.h1 ?? 0;
    const txnsH1 = this.countTxns(pair.txns?.h1);
    const threshold = this.getDexDropThresholdPercent();

    if (dexChange1h === undefined) {
      return {
        accepted: false,
        reason:
          "کوین نامعتبر شد: DexScreener تغییر قیمت یک‌ساعته برای pair اصلی ندارد.",
      };
    }

    if (dexChange1h > threshold) {
      return {
        accepted: false,
        reason: `کوین نامعتبر شد: افت یک‌ساعته DEX تایید نشد. افت منبع با DEX هم‌خوان نیست؛ DEX=${dexChange1h.toFixed(2)}%، آستانه=${threshold}%.`,
      };
    }

    if (volumeH1 < this.getMinDexVolumeH1Usd()) {
      return {
        accepted: false,
        reason: `کوین نامعتبر شد: حجم یک‌ساعته DEX کافی نیست. حجم=${volumeH1} دلار، حداقل=${this.getMinDexVolumeH1Usd()} دلار.`,
      };
    }

    if (txnsH1 < this.getMinDexTxnsH1()) {
      return {
        accepted: false,
        reason: `کوین نامعتبر شد: تعداد معاملات یک‌ساعته DEX کافی نیست. تعداد=${txnsH1}، حداقل=${this.getMinDexTxnsH1()}.`,
      };
    }

    return {
      accepted: true,
      reason: "نوسان یک‌ساعته DEX تایید شد.",
    };
  }

  private isPairForToken(pair: DexScreenerPair, tokenAddress: string): boolean {
    const normalizedTokenAddress = tokenAddress.toLowerCase();

    return [pair.baseToken?.address, pair.quoteToken?.address].some(
      (address) => address?.toLowerCase() === normalizedTokenAddress,
    );
  }

  private countTxns(txns?: { buys?: number; sells?: number }): number {
    return (txns?.buys ?? 0) + (txns?.sells ?? 0);
  }

  private getEnabledChains(): string[] {
    return this.getList("TRADE_ENABLED_CHAINS", ["solana", "ethereum"]);
  }

  private getAllowedDexIds(chain: SupportedChain): string[] {
    if (chain === "ethereum") {
      return this.getList("TRADE_ALLOWED_ETHEREUM_DEX_IDS", [
        "uniswap",
        "sushiswap",
        "curve",
        "balancer",
        "pancakeswap",
        "shibaswap",
      ]);
    }

    return this.getList("TRADE_ALLOWED_SOLANA_DEX_IDS", [
      "raydium",
      "orca",
      "meteora",
      "pumpswap",
      "pancakeswap",
      "lifinity",
      "jupiter-studio",
    ]);
  }

  private getMinLiquidityUsd(): number {
    return this.getNumber("TRADE_MIN_LIQUIDITY_USD", 1000, 0, 1_000_000);
  }

  private getMinDexVolumeH1Usd(): number {
    return this.getNumber("TRADE_MIN_DEX_VOLUME_H1_USD", 1000, 0, 1_000_000);
  }

  private getMinDexTxnsH1(): number {
    return this.getNumber("TRADE_MIN_DEX_TXNS_H1", 20, 0, 1_000);
  }

  private getDexDropThresholdPercent(): number {
    return -Math.abs(
      this.getNumber("TRADE_DEX_DROP_THRESHOLD_PERCENT", 70, 1, 99),
    );
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

  private getList(key: string, fallback: string[]): string[] {
    const value = this.configService.get<string>(key);

    if (!value) {
      return fallback;
    }

    return value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }
}
