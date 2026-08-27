// Live mainnet data access: RPC scan + Jupiter Swap V2 /build + price/token
// list. Mirrors crates/dust-planner: rpc.rs, jupiter.rs.

import {
  Connection,
  PublicKey,
  AccountInfo,
} from "@solana/web3.js";
import {
  AccountLayout,
  ExtensionType,
  getTransferFeeAmount,
  getExtensionTypes,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  JUPITER_BUILD_URL,
  JUPITER_PRICE_URL,
  JUPITER_TOKEN_LIST_URL,
  SLIPPAGE_BPS,
  SWAP_MAX_ACCOUNTS_TRIES,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  SOL_MINT,
} from "./constants";
import type { TokenProgramKind } from "./types";

export interface RawAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}
export interface RawInstruction {
  programId: string;
  accounts: RawAccountMeta[];
  data: string; // base64
}
export interface JupiterBuildPlan {
  inAmount: bigint;
  outAmount: bigint;
  otherAmountThreshold: bigint;
  routePlan: { outAmount: string; inAmount: string; swapInfo?: { label?: string; ammKey?: string } }[];
  computeBudgetInstructions: RawInstruction[];
  setupInstructions: RawInstruction[];
  swapInstruction: RawInstruction;
  cleanupInstruction: RawInstruction | null;
  otherInstructions: RawInstruction[];
  addressesByLookupTableAddress: Record<string, string[]>;
}
export interface ScannedTokenAccount {
  pubkey: PublicKey;
  mint: PublicKey;
  amount: bigint;
  lamports: number;
  tokenProgramId: PublicKey;
  decimals: number;
  tokenProgramKind: TokenProgramKind;
  supported: boolean;
  canSwap: boolean;
  canBurn: boolean;
  canClose: boolean;
  reason?: string;
}

const jupiterApiKey = import.meta.env.VITE_JUPITER_API_KEY as string | undefined;

async function jupiterGet(
  url: string,
  params: Record<string, string>
): Promise<any> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u.toString(), {
    headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jupiter HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Token metadata (symbols/names) — fetched once per session.
// ---------------------------------------------------------------------------
let tokenMetaPromise: Promise<
  Map<string, { symbol: string; name: string; logo?: string }>
> | null = null;

export function fetchTokenMeta(): Promise<
  Map<string, { symbol: string; name: string; logo?: string }>
> {
  if (!tokenMetaPromise) {
    tokenMetaPromise = (async () => {
      const res = await fetch(JUPITER_TOKEN_LIST_URL);
      if (!res.ok) throw new Error(`token list HTTP ${res.status}`);
      const list: {
        id: string;
        symbol: string;
        name: string;
        icon?: string | null;
      }[] = await res.json();
      const map = new Map<
        string,
        { symbol: string; name: string; logo?: string }
      >();
      for (const t of list) {
        if (!t.id) continue;
        map.set(t.id, {
          symbol: t.symbol,
          name: t.name,
          logo: t.icon ?? undefined,
        });
      }
      return map;
    })();
    // let a later scan retry if the first fetch failed
    tokenMetaPromise.catch(() => {
      tokenMetaPromise = null;
    });
  }
  return tokenMetaPromise;
}

export async function tokenSymbol(
  mint: string,
  fallbackSymbol: string
): Promise<{ symbol: string; name: string }> {
  try {
    const meta = await fetchTokenMeta();
    const hit = meta.get(mint);
    if (hit) return hit;
  } catch {
    // token list unavailable; fall through to the fallback
  }
  return { symbol: fallbackSymbol, name: `Token ${fallbackSymbol}` };
}

// ---------------------------------------------------------------------------
// Prices (USD per token unit) — one call per scan.
// ---------------------------------------------------------------------------
let priceCache: Map<string, number> | null = null;
let priceCacheAt = 0;

export async function fetchPrices(
  mints: PublicKey[],
  force = false
): Promise<Map<string, number>> {
  const now = Date.now();
  if (!force && priceCache && now - priceCacheAt < 60_000) return priceCache;
  const ids = [...new Set([SOL_MINT.toBase58(), ...mints.map((m) => m.toBase58())])];
  const map = new Map<string, number>();
  try {
    const data = await jupiterGet(JUPITER_PRICE_URL, { ids: ids.join(",") });
    for (const [mint, entry] of Object.entries(data ?? {})) {
      const price = Number((entry as any).usdPrice);
      if (Number.isFinite(price)) map.set(mint, price);
    }
  } catch {
    // prices are display-only; leave the map empty
  }
  priceCache = map;
  priceCacheAt = now;
  return map;
}

// ---------------------------------------------------------------------------
// Position scan (mirror rpc.rs scan_token_accounts + validate_token_support).
// ---------------------------------------------------------------------------
async function rpcRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // The public RPC endpoint rate-limits aggressively; retry once before giving
  // up so a transient 429 does not masquerade as "no tokens in this wallet".
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 900));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${label} failed: ${msg}`);
}

export type ScanProgress = {
  stage: "accounts" | "mints";
  done: number;
  total: number;
  message: string;
};

export async function scanTokenAccounts(
  connection: Connection,
  owner: PublicKey,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScannedTokenAccount[]> {
  onProgress?.({ stage: "accounts", done: 0, total: 2, message: "Reading SPL and Token-2022 accounts" });
  const [splRes, t22Res] = await Promise.allSettled([
    rpcRetry("token account scan", () =>
      connection.getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })
    ),
    rpcRetry("token-2022 scan", () =>
      connection.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
    ),
  ]);
  if (splRes.status === "rejected" && t22Res.status === "rejected") {
    throw new Error(`token scans failed: ${splRes.reason}; ${t22Res.reason}`);
  }
  const all = [
    ...(splRes.status === "fulfilled" ? splRes.value.value.map((v) => ({ ...v, tokenProgramId: TOKEN_PROGRAM_ID })) : []),
    ...(t22Res.status === "fulfilled" ? t22Res.value.value.map((v) => ({ ...v, tokenProgramId: TOKEN_2022_PROGRAM_ID })) : []),
  ];
  onProgress?.({ stage: "accounts", done: 2, total: 2, message: `Found ${all.length} token accounts` });

  const mints = [...new Set(all.map((v) => AccountLayout.decode(v.account.data).mint.toBase58()))];
  const mintInfos = new Map<string, AccountInfo<Buffer>>();
  const mintProgram = new Map<string, string>();
  const chunkSize = 50;
  const totalChunks = Math.max(1, Math.ceil(mints.length / chunkSize));
  for (let i = 0; i < mints.length; i += chunkSize) {
    const chunkIndex = Math.floor(i / chunkSize) + 1;
    onProgress?.({ stage: "mints", done: chunkIndex - 1, total: totalChunks, message: `Loading mint metadata ${chunkIndex}/${totalChunks}` });
    const chunk = mints
      .slice(i, i + chunkSize)
      .map((m) => new PublicKey(m));
    const infos = await rpcRetry("mint metadata", () => connection.getMultipleAccountsInfo(chunk));
    infos.forEach((info, idx) => {
      if (!info) return;
      mintInfos.set(chunk[idx].toBase58(), info);
      mintProgram.set(chunk[idx].toBase58(), info.owner.toBase58());
    });
    onProgress?.({ stage: "mints", done: chunkIndex, total: totalChunks, message: `Loaded mint metadata ${chunkIndex}/${totalChunks}` });
  }

  const out: ScannedTokenAccount[] = [];
  for (const v of all) {
    const data = v.account.data;
    if (data.length === 0) continue; // closed/rent-reclaimable account, not a position
    if (data.length < AccountLayout.span) continue;
    const parsed = AccountLayout.decode(data);
    if (parsed.owner.toBase58() !== owner.toBase58()) continue;
    if (parsed.state !== 1) continue; // only initialized accounts

    const mintKey = parsed.mint.toBase58();
    const mintInfo = mintInfos.get(mintKey);
    const mintOwner = mintProgram.get(mintKey);
    if (!mintInfo) continue;
    const decimals = mintInfo.data[44] ?? 0;

    let kind: TokenProgramKind;
    let supported = true;
    let canSwap = true;
    let canBurn = true;
    let canClose = true;
    let reason: string | undefined;
    const programStr = v.tokenProgramId.toBase58();
    if (programStr === TOKEN_PROGRAM_ID.toBase58()) {
      kind = "SPL Token";
    } else if (programStr === TOKEN_2022_PROGRAM_ID.toBase58()) {
      kind = "Token-2022";
      try {
        // Mirror the program's operation-specific policy. A transfer hook is
        // swap-capable when Jupiter can build the route; burn does not invoke
        // the hook, and an empty hook account can be closed normally.
        const mintState = unpackMint(parsed.mint, mintInfo, TOKEN_2022_PROGRAM_ID);
        const accountState = unpackAccount(v.pubkey, v.account, TOKEN_2022_PROGRAM_ID);
        const mintExtensions = getExtensionTypes(mintState.tlvData);
        const accountExtensions = getExtensionTypes(accountState.tlvData);
        const burnCloseMint = new Set<number>([
          ExtensionType.TransferFeeConfig,
          ExtensionType.MintCloseAuthority,
          ExtensionType.DefaultAccountState,
          ExtensionType.NonTransferable,
          ExtensionType.InterestBearingConfig,
          ExtensionType.PermanentDelegate,
          ExtensionType.TransferHook,
          ExtensionType.MetadataPointer,
          ExtensionType.TokenMetadata,
          ExtensionType.GroupPointer,
          ExtensionType.TokenGroup,
          ExtensionType.GroupMemberPointer,
          ExtensionType.TokenGroupMember,
          ExtensionType.ScaledUiAmountConfig,
          ExtensionType.PausableConfig,
        ]);
        const burnCloseAccount = new Set<number>([
          ExtensionType.TransferFeeAmount,
          ExtensionType.ImmutableOwner,
          ExtensionType.MemoTransfer,
          ExtensionType.NonTransferableAccount,
          ExtensionType.TransferHookAccount,
          ExtensionType.PausableAccount,
        ]);
        const rejectedMint = mintExtensions.filter((e) => !burnCloseMint.has(e));
        const rejectedAccount = accountExtensions.filter((e) => !burnCloseAccount.has(e));
        canBurn = rejectedMint.length === 0 && rejectedAccount.length === 0;
        canClose = canBurn;
        canSwap = canClose &&
          !mintExtensions.includes(ExtensionType.NonTransferable) &&
          !mintExtensions.includes(ExtensionType.ConfidentialTransferMint) &&
          !accountExtensions.includes(ExtensionType.ConfidentialTransferAccount) &&
          !accountExtensions.includes(ExtensionType.CpiGuard);

        const transferFee = getTransferFeeAmount(accountState);
        if (transferFee && transferFee.withheldAmount > 0n) {
          canBurn = false;
          canClose = false;
          reason = "Withheld transfer fees must be harvested before this account can close.";
        } else if (rejectedMint.length || rejectedAccount.length) {
          reason = `Burn/close unsupported for Token-2022 extension (${[
            ...rejectedMint,
            ...rejectedAccount,
          ].map((e) => ExtensionType[e] ?? e).join(", ")}).`;
        }
        if (accountState.isFrozen) {
          canSwap = false;
          canBurn = false;
          canClose = false;
          reason = "Frozen Token-2022 account; thaw it before tidying.";
        }
        supported = BigInt(parsed.amount.toString()) === 0n ? canClose : canSwap || canBurn;
      } catch {
        supported = false;
        canSwap = false;
        canBurn = false;
        canClose = false;
        reason = "Token-2022 mint or account data could not be decoded safely.";
      }
    } else {
      kind = "Unsupported";
      supported = false;
      canSwap = false;
      canBurn = false;
      canClose = false;
      reason = "Unsupported token program.";
    }

    out.push({
      pubkey: v.pubkey,
      mint: parsed.mint,
      amount: BigInt(parsed.amount.toString()),
      lamports: v.account.lamports,
      tokenProgramId: v.tokenProgramId,
      decimals,
      tokenProgramKind: kind,
      supported,
      canSwap,
      canBurn,
      canClose,
      reason,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Jupiter Swap V2 /build (top-level instructions + Jupiter-managed LUT data).
// ---------------------------------------------------------------------------
export interface BuildRequest {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: bigint;
  taker: PublicKey;
  platformFeeBps?: number;
  feeAccount?: PublicKey;
  destinationTokenAccount?: PublicKey;
}

export async function jupiterBuild(req: BuildRequest, maxAccounts: number): Promise<JupiterBuildPlan> {
  const params: Record<string, string> = {
    inputMint: req.inputMint.toBase58(),
    outputMint: req.outputMint.toBase58(),
    amount: req.amount.toString(),
    taker: req.taker.toBase58(),
    slippageBps: String(SLIPPAGE_BPS),
    wrapAndUnwrapSol: "true",
    maxAccounts: String(maxAccounts),
  };
  if (req.platformFeeBps !== undefined) params.platformFeeBps = String(req.platformFeeBps);
  if (req.feeAccount) params.feeAccount = req.feeAccount.toBase58();
  if (req.destinationTokenAccount) params.destinationTokenAccount = req.destinationTokenAccount.toBase58();

  const v = await jupiterGet(JUPITER_BUILD_URL, params);
  return {
    inAmount: BigInt(v.inAmount),
    outAmount: BigInt(v.outAmount),
    otherAmountThreshold: BigInt(v.otherAmountThreshold),
    routePlan: Array.isArray(v.routePlan) ? v.routePlan : [],
    computeBudgetInstructions: Array.isArray(v.computeBudgetInstructions) ? v.computeBudgetInstructions : [],
    setupInstructions: Array.isArray(v.setupInstructions) ? v.setupInstructions : [],
    swapInstruction: v.swapInstruction,
    cleanupInstruction: v.cleanupInstruction && !Array.isArray(v.cleanupInstruction) ? v.cleanupInstruction : null,
    otherInstructions: Array.isArray(v.otherInstructions) ? v.otherInstructions : [],
    addressesByLookupTableAddress:
      v.addressesByLookupTableAddress && typeof v.addressesByLookupTableAddress === "object"
        ? v.addressesByLookupTableAddress
        : {},
  };
}

/** Try maxAccounts=48 then 56 (mirror build_cpi_compatible_route). */
export async function buildCpiCompatibleRoute(req: BuildRequest): Promise<JupiterBuildPlan> {
  let lastErr: Error | null = null;
  for (const maxAccounts of SWAP_MAX_ACCOUNTS_TRIES) {
    try {
      return await jupiterBuild(req, maxAccounts);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message;
      if (!/route|too many|maxAccounts/i.test(msg)) throw lastErr;
    }
  }
  throw lastErr ?? new Error("no CPI-compatible Jupiter route found");
}

/** Build an unrestricted route. LUT compression is applied by the caller. */
export async function buildTopLevelRoute(req: BuildRequest): Promise<JupiterBuildPlan> {
  // Reserve packet space for ATA creation and the protocol close instruction.
  return jupiterBuild(req, 32);
}

/**
 * How many output units 1 SOL buys — used to normalize swap output value into
 * SOL lamports (mirror main.rs sol_per_output_unit). Fallback: price API.
 */
export async function solPerOutputUnit(
  taker: PublicKey,
  outputMint: PublicKey,
  prices: Map<string, number>,
): Promise<bigint> {
  try {
    const plan = await jupiterBuild(
      { inputMint: SOL_MINT, outputMint, amount: 1_000_000_000n, taker },
      48
    );
    if (plan.outAmount > 0n) return plan.outAmount;
  } catch {
    // fall through to price API
  }
  const solUsd = prices.get(SOL_MINT.toBase58());
  // USDC and USDT both use 6 decimals and are treated as $1 for this
  // best-effort fallback. Executable Jupiter quotes remain authoritative.
  if (solUsd) return BigInt(Math.round(solUsd * 1_000_000));
  return 0n;
}

export function asBase64U8(data: string): Uint8Array {
  // Browser-compatible base64 -> bytes (no Buffer dependency at runtime).
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
