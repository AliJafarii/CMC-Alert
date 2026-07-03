export interface TradeSettings {
  enabled: boolean;
  mode: "dry-run";
  solAmount: number;
  walletAddress: string;
  solanaOnly: boolean;
  minLiquidityUsd: number;
  allowedSolanaDexIds: string[];
}

export interface TradeValidationResult {
  enabled: boolean;
  accepted: boolean;
  reason: string;
  chain?: string;
  tokenAddress?: string;
  explorerUrl?: string;
  dexId?: string;
  pairUrl?: string;
  liquidityUsd?: number;
  walletSolBalance?: number;
  requestedSolAmount?: number;
  dryRun: boolean;
}
