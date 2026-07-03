export interface TradeSettings {
  enabled: boolean;
  mode: "dry-run";
  solAmount: number;
  ethAmount: number;
  walletAddress: string;
  ethWalletAddress: string;
  solanaOnly: boolean;
  enabledChains: string[];
  minLiquidityUsd: number;
  showHighRiskAlerts: boolean;
  autoBuyDropThresholdPercent: number;
  allowedSolanaDexIds: string[];
  allowedEthereumDexIds: string[];
}

export type TradeDecision =
  | "disabled"
  | "rejected"
  | "high_risk"
  | "review"
  | "auto_buy";

export interface TradeValidationResult {
  enabled: boolean;
  accepted: boolean;
  decision: TradeDecision;
  reason: string;
  chain?: string;
  tokenAddress?: string;
  explorerUrl?: string;
  dexId?: string;
  pairUrl?: string;
  liquidityUsd?: number;
  riskSummary?: string;
  priceChange1hPercent?: number;
  autoBuyDropThresholdPercent?: number;
  nativeSymbol?: string;
  walletNativeBalance?: number;
  requestedNativeAmount?: number;
  walletSolBalance?: number;
  requestedSolAmount?: number;
  dryRun: boolean;
}
