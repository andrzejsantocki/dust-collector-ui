// Decision model — mirrors crates/dust-planner classifier.rs + economics.rs.
// One position + quote + config -> Action.

import type { Position, ConfigView } from "./types";
import type { ScannedTokenAccount, JupiterBuildPlan } from "./api";
import {
  LAMPORTS_PER_SOL,
  NETWORK_FEE_LAMPORTS,
  PRIORITY_FEE_LAMPORTS,
  USER_MAX_FEE_LAMPORTS,
  USDC_MINT,
  SOL_MINT,
} from "./constants";

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** bounded_fee mirror (utils/fees.rs): prop.max(min).min(max).min(rent).min(userMax). */
export function boundedFee(
  reclaimed: bigint,
  bps: number,
  minFee: bigint,
  maxFee: bigint,
  userMax: bigint
): bigint {
  const prop = (reclaimed * BigInt(bps)) / 10_000n;
  return minBig(minBig(minBig(maxBig(prop, minFee), maxFee), reclaimed), userMax);
}

/** output_units_to_sol_lamports mirror: units * 1e9 / sol_per_output_unit. */
export function outputUnitsToSolLamports(units: bigint, solPerOutputUnit: bigint): bigint {
  if (solPerOutputUnit === 0n) return units;
  return (units * LAMPORTS_PER_SOL) / solPerOutputUnit;
}

export function formatAmount(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function usdOf(raw: bigint, priceUsd: number | undefined, decimals: number): number | null {
  if (priceUsd === undefined || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  return (Number(raw) / 10 ** decimals) * priceUsd;
}

export interface ClassifyArgs {
  scanned: ScannedTokenAccount;
  config: ConfigView | null;
  /** fee-less /build quote for the position (route existence + output). */
  quote: JupiterBuildPlan | null;
  /** USDC units per SOL (from SOL->USDC quote or price API). */
  solPerOutputUnit: bigint;
  prices: Map<string, number>;
  /** Mints treated as the protocol's output currency — never dust. */
  excludedMints?: Set<string>;
}

/**
 * classify mirror:
 *   amount == 0                      -> close
 *   non-empty output mint            -> keep
 *   no route                         -> burn
 *   swap_net <= burn_net             -> burn
 *   else                             -> swap
 */
export function classifyPosition(args: ClassifyArgs): Position {
  const { scanned, config, quote, solPerOutputUnit, prices } = args;
  const id = scanned.pubkey.toBase58();
  const priceUsd = prices.get(scanned.mint.toBase58());
  const valueUsdc = usdOf(scanned.amount, priceUsd, scanned.decimals);
  const rentLamports = scanned.lamports;

  if (!scanned.supported) {
    return {
      id,
      tokenAccount: id,
      mint: scanned.mint.toBase58(),
      symbol: scanned.pubkey.toBase58().slice(0, 4),
      name: "Unsupported token",
      amount: formatAmount(scanned.amount, scanned.decimals),
      amountRaw: scanned.amount,
      decimals: scanned.decimals,
      valueUsdc,
      rentLamports,
      action: "unsupported",
      actionReason: scanned.reason ?? "Unsupported token program or extension.",
      priceStatus: priceUsd ? "priced" : "unknown",
      tokenProgram: scanned.tokenProgramKind,
      tokenProgramId: scanned.tokenProgramId.toBase58(),
      netRecoveryLamports: 0,
    };
  }

  // Output currency (USDC/USDT/SOL chosen in setup) is a destination, never
  // dust — keep it even when the balance is small or the account is empty.
  const mintStr = scanned.mint.toBase58();
  if (args.excludedMints?.has(mintStr)) {
    return {
      id,
      tokenAccount: id,
      mint: mintStr,
      symbol: mintStr.slice(0, 4),
      name: "Output currency",
      amount: formatAmount(scanned.amount, scanned.decimals),
      amountRaw: scanned.amount,
      decimals: scanned.decimals,
      valueUsdc,
      rentLamports,
      action: "keep",
      actionReason: "Destination currency — kept out of the tidy plan.",
      priceStatus: priceUsd ? "priced" : "unknown",
      tokenProgram: scanned.tokenProgramKind,
      tokenProgramId: scanned.tokenProgramId.toBase58(),
      netRecoveryLamports: 0,
    };
  }

  const closeFeeBps = config?.closeFeeBps ?? 500;
  const closeMin = config?.closeMinFeeLamports ?? 0n;
  const closeMax = config?.closeMaxFeeLamports ?? 100_000n;

  if (scanned.amount === 0n) {
    const fee = boundedFee(BigInt(rentLamports), closeFeeBps, closeMin, closeMax, USER_MAX_FEE_LAMPORTS);
    const net = BigInt(rentLamports) - fee;
    return {
      id,
      tokenAccount: id,
      mint: scanned.mint.toBase58(),
      symbol: scanned.pubkey.toBase58().slice(0, 4),
      name: "Empty token account",
      amount: "0",
      amountRaw: 0n,
      decimals: scanned.decimals,
      valueUsdc: 0,
      rentLamports,
      action: "close",
      actionReason: "This account is empty. Close it and recover its rent.",
      priceStatus: "priced",
      tokenProgram: scanned.tokenProgramKind,
      tokenProgramId: scanned.tokenProgramId.toBase58(),
      protocolFeeLamports: Number(fee),
      netRecoveryLamports: Number(net),
    };
  }

  if (scanned.mint.equals(USDC_MINT)) {
    return {
      id,
      tokenAccount: id,
      mint: scanned.mint.toBase58(),
      symbol: "USDC",
      name: "USD Coin",
      amount: formatAmount(scanned.amount, scanned.decimals),
      amountRaw: scanned.amount,
      decimals: scanned.decimals,
      valueUsdc,
      rentLamports,
      action: "keep",
      actionReason: "This is the configured swap output asset and will not be burned.",
      priceStatus: priceUsd ? "priced" : "unknown",
      tokenProgram: scanned.tokenProgramKind,
      tokenProgramId: scanned.tokenProgramId.toBase58(),
      netRecoveryLamports: 0,
    };
  }

  const fee = boundedFee(
    BigInt(rentLamports), closeFeeBps, closeMin, closeMax, USER_MAX_FEE_LAMPORTS
  );

  // A missing route is not evidence that a token is worthless. Burn only
  // when fresh pricing proves the destroyed value is no greater than the net
  // USD value recovered from account rent. Unknown price => keep.
  if (!quote) {
    const solUsd = prices.get(SOL_MINT.toBase58());
    const netRentLamports = BigInt(rentLamports) > fee + NETWORK_FEE_LAMPORTS + PRIORITY_FEE_LAMPORTS
      ? BigInt(rentLamports) - fee - NETWORK_FEE_LAMPORTS - PRIORITY_FEE_LAMPORTS
      : 0n;
    const netRentUsd = solUsd
      ? (Number(netRentLamports) / Number(LAMPORTS_PER_SOL)) * solUsd
      : null;
    if (!scanned.canBurn || valueUsdc === null || netRentUsd === null || valueUsdc > netRentUsd) {
      return {
        id,
        tokenAccount: id,
        mint: scanned.mint.toBase58(),
        symbol: scanned.pubkey.toBase58().slice(0, 4),
        name: "Token",
        amount: formatAmount(scanned.amount, scanned.decimals),
        amountRaw: scanned.amount,
        decimals: scanned.decimals,
        valueUsdc,
        rentLamports,
        action: "keep",
        actionReason: !scanned.canBurn
          ? "This Token-2022 display extension requires manual valuation, so automatic burn is disabled."
          : valueUsdc === null || netRentUsd === null
          ? "No swap route and no reliable live price. Kept by the safety policy."
          : `No swap route. Its ${valueUsdc.toFixed(6)} USDC value exceeds the ${netRentUsd.toFixed(6)} USDC net rent recovery.`,
        priceStatus: priceUsd ? "priced" : "unknown",
        tokenProgram: scanned.tokenProgramKind,
        tokenProgramId: scanned.tokenProgramId.toBase58(),
        netRecoveryLamports: 0,
      };
    }
  }

  // No quote: burn + close (mirror main.rs).
  const quotePlan = quote;
  const expectedOutSol = quotePlan
    ? outputUnitsToSolLamports(quotePlan.outAmount, solPerOutputUnit)
    : 0n;

  const econ = {
    network: NETWORK_FEE_LAMPORTS,
    priority: PRIORITY_FEE_LAMPORTS,
    dex: 0n,
    protocol: closeMax,
    slippage: expectedOutSol / 100n,
  };
  const totalCost = econ.network + econ.priority + econ.dex + econ.protocol + econ.slippage;
  const burnNet = BigInt(rentLamports) - econ.network - econ.priority - econ.protocol;
  const swapNet = expectedOutSol + BigInt(rentLamports) - totalCost;

  const outUsdc = quotePlan ? Number(quotePlan.outAmount) / 10 ** 6 : undefined;
  const swapUsd = quotePlan ? Number(quotePlan.outAmount) / 10 ** 6 : undefined;

  if (quotePlan && swapNet > burnNet) {
    const swapFeeUsdc =
      ((Number(quotePlan.outAmount) / 10 ** 6) * (config?.swapFeeBps ?? 50)) / 10_000;
    const route = (quotePlan.routePlan ?? [])
      .map((s) => s.swapInfo?.label ?? "?")
      .filter(Boolean)
      .join(" → ");
    return {
      id,
      tokenAccount: id,
      mint: scanned.mint.toBase58(),
      symbol: scanned.pubkey.toBase58().slice(0, 4),
      name: "Token",
      amount: formatAmount(scanned.amount, scanned.decimals),
      amountRaw: scanned.amount,
      decimals: scanned.decimals,
      valueUsdc,
      rentLamports,
      action: "swap",
      actionReason: "A Jupiter route produces more value than burning and closing.",
      priceStatus: priceUsd ? "priced" : "unknown",
      tokenProgram: scanned.tokenProgramKind,
      tokenProgramId: scanned.tokenProgramId.toBase58(),
      swapOutputUsdc: outUsdc,
      swapFeeUsdc,
      slippageUsdc: swapUsd !== undefined ? swapUsd * 0.01 : undefined,
      netRecoveryLamports: Number(swapNet),
      route: route || undefined,
    };
  }

  // A quote is also our best executable proof of the value that burning
  // destroys. Even when swapping loses to burn because route costs are high,
  // do not burn unless recovered rent still exceeds that destroyed value.
  if (quotePlan && expectedOutSol > (burnNet > 0n ? burnNet : 0n)) {
    return {
      id,
      tokenAccount: id,
      mint: scanned.mint.toBase58(),
      symbol: scanned.pubkey.toBase58().slice(0, 4),
      name: "Token",
      amount: formatAmount(scanned.amount, scanned.decimals),
      amountRaw: scanned.amount,
      decimals: scanned.decimals,
      valueUsdc,
      rentLamports,
      action: "keep",
      actionReason:
        "The executable quote proves the tokens are worth more than the net rent recovered by burning.",
      priceStatus: priceUsd ? "priced" : "unknown",
      tokenProgram: scanned.tokenProgramKind,
      tokenProgramId: scanned.tokenProgramId.toBase58(),
      netRecoveryLamports: 0,
    };
  }

  // Business rule (mirror classifier.rs): burn ONLY when provably net-positive.
  // Burning destroys the tokens, so it is sent only if the recovered rent
  // minus ALL costs (network + priority + worst-case protocol fee) is > 0.
  if (burnNet <= 0n) {
    return {
      id,
      tokenAccount: id,
      mint: scanned.mint.toBase58(),
      symbol: scanned.pubkey.toBase58().slice(0, 4),
      name: "Token",
      amount: formatAmount(scanned.amount, scanned.decimals),
      amountRaw: scanned.amount,
      decimals: scanned.decimals,
      valueUsdc,
      rentLamports,
      action: "keep",
      actionReason:
        "Burning would recover less than it costs (rent minus fees is not positive). Kept by the safety policy.",
      priceStatus: priceUsd ? "priced" : "unknown",
      tokenProgram: scanned.tokenProgramKind,
      tokenProgramId: scanned.tokenProgramId.toBase58(),
      netRecoveryLamports: 0,
    };
  }

  return {
    id,
    tokenAccount: id,
    mint: scanned.mint.toBase58(),
    symbol: scanned.pubkey.toBase58().slice(0, 4),
    name: "Token",
    amount: formatAmount(scanned.amount, scanned.decimals),
    amountRaw: scanned.amount,
    decimals: scanned.decimals,
    valueUsdc,
    rentLamports,
    action: "burn",
    actionReason: quotePlan
      ? "Swapping would recover less than burning and closing."
      : "No economic swap route. Burning permits the account to close.",
    priceStatus: priceUsd ? "priced" : "unknown",
    tokenProgram: scanned.tokenProgramKind,
    tokenProgramId: scanned.tokenProgramId.toBase58(),
    protocolFeeLamports: Number(fee),
    netRecoveryLamports: Number(burnNet),
  };
}
