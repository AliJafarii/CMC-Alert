export interface TradeSettings {
  enabled: boolean;
  mode: "dry-run";
  solAmount: number;
  walletAddress: string;
  solanaOnly: boolean;
  minLiquidityUsd: number;
  showHighRiskAlerts: boolean;
  allowedSolanaDexIds: string[];
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
  walletSolBalance?: number;
  requestedSolAmount?: number;
  dryRun: boolean;
}
