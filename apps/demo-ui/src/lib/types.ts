// Real-backend position model. Mirrors the on-chain contract and the Rust
// planner's decision model (crates/dust-planner: classifier.rs, economics.rs).

export type ActionKind = "close" | "burn" | "swap" | "keep" | "unsupported";
export type PriceStatus = "priced" | "unknown";
export type TokenProgramKind = "SPL Token" | "Token-2022" | "Unsupported";

export interface Position {
  id: string;
  tokenAccount: string;
  mint: string;
  symbol: string;
  name: string;
  /** Icon URL when known (curated list or on-chain metadata JSON). */
  logo?: string;
  amount: string; // human-readable
  amountRaw: bigint;
  decimals: number;
  valueUsdc: number | null;
  rentLamports: number; // recoverable when closed
  action: ActionKind;
  actionReason: string;
  priceStatus: PriceStatus;
  tokenProgram: TokenProgramKind;
  tokenProgramId: string;
  swapOutputUsdc?: number;
  /** Close/burn protocol fee (lamports). */
  protocolFeeLamports?: number;
  /** Swap platform fee estimate in output USDC units. */
  swapFeeUsdc?: number;
  slippageUsdc?: number;
  netRecoveryLamports: number;
  route?: string;
}

export interface ConfigView {
  admin: string;
  protocolVault: string;
  closeFeeBps: number;
  closeMinFeeLamports: bigint;
  closeMaxFeeLamports: bigint;
  swapFeeBps: number;
  swapMaxFeeBps: number;
  jupiterProgram: string;
  paused: boolean;
}

export interface ProtocolStatsView {
  successfulOperations: bigint;
  successfulCloses: bigint;
  successfulBurns: bigint;
  successfulSwaps: bigint;
  totalRentRecoveredLamports: bigint;
  totalCloseFeesLamports: bigint;
  lastUpdatedSlot: bigint;
}

export type ConfigStatus = "loading" | "ok" | "missing" | "error";

export interface TxResult {
  positionIds: string[];
  label: string;
  signature: string;
  error?: string;
  /** Where the failure happened: build | simulation | on-chain | send */
  errorPhase?: string;
}

export type DemoStage = "setup" | "review" | "confirm" | "processing" | "complete";
export type ThresholdMode = "fixed" | "percent";

export interface WalletSummary {
  address: string;
  solBalance: number;
  portfolioValueUsdc: number;
}
