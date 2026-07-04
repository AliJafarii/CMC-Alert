import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { firstValueFrom } from "rxjs";
import { TradeSettingsService } from "./trade-settings.service";
import { TradeValidationResult } from "./trade-validation.types";

interface TradingHotWalletFile {
  solana?: {
    publicKey?: string;
    secretKeyBase58?: string;
  };
  ethereum?: {
    address?: string;
    privateKey?: string;
  };
}

interface JupiterQuoteResponse {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  routePlan?: unknown[];
}

interface ParsedMintAccount {
  value?: {
    data?: {
      parsed?: {
        info?: {
          decimals?: number;
        };
      };
    };
  };
}

interface JupiterSwapResponse {
  swapTransaction?: string;
}

@Injectable()
export class TradeExecutionService {
  private readonly logger = new Logger(TradeExecutionService.name);
  private readonly solMint = "So11111111111111111111111111111111111111112";

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly tradeSettingsService: TradeSettingsService,
  ) {}

  async executeIfNeeded(
    result: TradeValidationResult,
  ): Promise<TradeValidationResult> {
    const settings = this.tradeSettingsService.getSettings();

    if (!result.enabled || !result.accepted) {
      return result;
    }

    if (settings.manualBuyLinksEnabled) {
      result.manualBuyUrl = this.createManualBuyUrl(result);
    }

    result.dryRun = settings.mode !== "live";

    if (result.decision !== "auto_buy") {
      result.executionStatus = "skipped";
      return result;
    }

    if (settings.mode !== "live") {
      result.executionStatus = "dry-run";
      result.dryRun = true;
      return result;
    }

    if (settings.executionStrategy === "manual-link") {
      result.executionStatus = "skipped";
      result.manualBuyUrl = this.createManualBuyUrl(result);
      result.dryRun = false;
      result.reason =
        "مجاز برای خرید است، اما روش اجرا روی لینک دستی است و تراکنش خودکار ارسال نشد.";
      return result;
    }

    try {
      if (result.chain === "solana") {
        return await this.executeSolanaBuy(result);
      }

      if (result.chain === "ethereum") {
        throw new Error(
          "اجرای خودکار اتریوم هنوز به مسیر swap امن و تست‌شده وصل نشده است؛ برای اتریوم فعلا از لینک دستی استفاده کن.",
        );
      }

      throw new Error("شبکه برای اجرای خرید پشتیبانی نمی‌شود.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Trade execution failed: ${message}`);
      result.executionStatus = "failed";
      result.executionError = message;
      result.dryRun = false;
      return result;
    }
  }

  private async executeSolanaBuy(
    result: TradeValidationResult,
  ): Promise<TradeValidationResult> {
    if (!result.tokenAddress || !result.requestedNativeAmount) {
      throw new Error("اطلاعات خرید سولانا کامل نیست.");
    }

    const wallet = this.loadHotWallet();
    const secretKey = wallet.solana?.secretKeyBase58;

    if (!secretKey) {
      throw new Error("کلید hot wallet سولانا روی سرور پیدا نشد.");
    }

    const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
    const amountLamports = Math.floor(result.requestedNativeAmount * 1_000_000_000);
    const slippageBps = Number(
      this.configService.get<string>("TRADE_SLIPPAGE_BPS") ?? 300,
    );
    const quote = await this.fetchJupiterQuote(
      result.tokenAddress,
      amountLamports,
      slippageBps,
    );
    const swapTransaction = await this.fetchJupiterSwap(quote, keypair.publicKey.toBase58());
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(swapTransaction, "base64"),
    );
    transaction.sign([keypair]);

    const connection = new Connection(
      this.configService.get<string>("SOLANA_RPC_URL") ??
        "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
    const outputDecimals = await this.fetchSolanaMintDecimals(
      connection,
      result.tokenAddress,
    );
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      maxRetries: 3,
      skipPreflight: false,
    });

    await connection.confirmTransaction(signature, "confirmed");

    result.executionStatus = "submitted";
    result.executionInputAmount = result.requestedNativeAmount;
    result.executionInputSymbol = "SOL";
    result.executionOutputAmountRaw = quote.outAmount;
    result.executionOutputAmount =
      quote.outAmount && outputDecimals !== undefined
        ? Number(quote.outAmount) / 10 ** outputDecimals
        : undefined;
    result.executionOutputTokenAddress = result.tokenAddress;
    result.executionSlippageBps = slippageBps;
    result.executionTxId = signature;
    result.executionUrl = `https://solscan.io/tx/${signature}`;
    result.dryRun = false;
    result.reason = "خرید واقعی سولانا با hot wallet ارسال شد.";
    return result;
  }

  private async fetchSolanaMintDecimals(
    connection: Connection,
    tokenAddress: string,
  ): Promise<number | undefined> {
    const accountInfo = (await connection.getParsedAccountInfo(
      new PublicKey(tokenAddress),
    )) as ParsedMintAccount;

    return accountInfo.value?.data?.parsed?.info?.decimals;
  }

  private async fetchJupiterQuote(
    outputMint: string,
    amountLamports: number,
    slippageBps: number,
  ): Promise<JupiterQuoteResponse> {
    const response = await firstValueFrom(
      this.httpService.get<JupiterQuoteResponse>(
        "https://quote-api.jup.ag/v6/quote",
        {
          params: {
            inputMint: this.solMint,
            outputMint,
            amount: amountLamports,
            slippageBps,
          },
          timeout: 20000,
        },
      ),
    );

    if (!response.data.routePlan?.length) {
      throw new Error("مسیر خرید Jupiter برای این توکن پیدا نشد.");
    }

    return response.data;
  }

  private async fetchJupiterSwap(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string,
  ): Promise<string> {
    const response = await firstValueFrom(
      this.httpService.post<JupiterSwapResponse>(
        "https://quote-api.jup.ag/v6/swap",
        {
          quoteResponse,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: "auto",
        },
        {
          timeout: 30000,
        },
      ),
    );

    if (!response.data.swapTransaction) {
      throw new Error("تراکنش خرید Jupiter ساخته نشد.");
    }

    return response.data.swapTransaction;
  }

  private loadHotWallet(): TradingHotWalletFile {
    const walletPath =
      this.configService.get<string>("TRADE_HOT_WALLET_PATH") ??
      join(process.cwd(), "secrets", "test-hot-wallet.json");

    if (!existsSync(walletPath)) {
      throw new Error("فایل hot wallet روی سرور پیدا نشد.");
    }

    return JSON.parse(readFileSync(walletPath, "utf8")) as TradingHotWalletFile;
  }

  private createManualBuyUrl(result: TradeValidationResult): string | undefined {
    if (!result.tokenAddress || !result.chain) {
      return undefined;
    }

    if (result.chain === "solana") {
      return `https://jup.ag/swap/SOL-${result.tokenAddress}`;
    }

    if (result.chain === "ethereum") {
      return `https://app.uniswap.org/swap?chain=mainnet&inputCurrency=ETH&outputCurrency=${result.tokenAddress}`;
    }

    return undefined;
  }
}
