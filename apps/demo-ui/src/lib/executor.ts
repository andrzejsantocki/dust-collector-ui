// Transaction building + sending for the real mainnet client.
// Mirrors crates/dust-planner transaction.rs / main.rs swap path, adapted to a
// browser wallet: every signature comes from the connected wallet (Solflare),
// so accounts created on demand use the ATA program (payer-only signing) —
// the vault fee account is the vault PDA's ATA instead of a random keypair.

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM,
} from "@solana/spl-token";
import { BN, Program } from "@coral-xyz/anchor";
import type { DustCollector } from "../../../../target/types/dust_collector";
import type { ConfigView, Position } from "./types";
import type { RawInstruction, JupiterBuildPlan } from "./api";
import {
  buildTopLevelRoute,
  asBase64U8,
} from "./api";
import {
  configPda,
  statsPda,
  vaultPda,
  MAX_TX_SIZE,
  USER_MAX_FEE_LAMPORTS,
  BATCH_SIZE,
} from "./constants";

const toTxInstruction = (ix: RawInstruction): TransactionInstruction =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: asBase64U8(ix.data) as unknown as Buffer,
  });

export interface BuildSwapResult {
  instructions: TransactionInstruction[];
  plan: JupiterBuildPlan;
  destinationAta: PublicKey;
  feeAta: PublicKey;
  lookupTables: AddressLookupTableAccount[];
}

/**
 * Build the swap_and_close transaction instructions for one position:
 * ATA creates (user destination + vault fee account) when missing, Jupiter
 * /build route as top-level instructions, then the protocol close instruction.
 * The close fee remains enforced on-chain; Jupiter's platform fee is requested
 * by this official client but is not independently enforced by the program.
 */
export async function buildSwapInstructions(
  program: Program<DustCollector>,
  connection: Connection,
  position: Position,
  config: ConfigView,
  walletAddress: PublicKey,
  outputMint: PublicKey,
  tokenProgramId: PublicKey
): Promise<BuildSwapResult> {
  const source = new PublicKey(position.tokenAccount);
  const mint = new PublicKey(position.mint);
  const configKey = configPda();
  const statsKey = statsPda();
  const vault = vaultPda();

  // vault is a PDA (off-curve): allowOwnerOffCurve=true, or spl-token's
  // address derivation throws. The ATA program itself accepts any owner.
  const [destinationAta, feeAta] = await Promise.all([
    getAssociatedTokenAddress(outputMint, walletAddress),
    getAssociatedTokenAddress(outputMint, vault, true),
  ]);

  const instructions: TransactionInstruction[] = [];
  const [destInfo, feeInfo] = await Promise.all([
    connection.getAccountInfo(destinationAta),
    connection.getAccountInfo(feeAta),
  ]);
  if (!destInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        walletAddress,
        destinationAta,
        walletAddress,
        outputMint,
        SPL_TOKEN_PROGRAM
      )
    );
  }
  if (!feeInfo) {
    // Vault PDA owns its ATA; anyone (the user) can create it — payer signs only.
    instructions.push(
      createAssociatedTokenAccountInstruction(
        walletAddress,
        feeAta,
        vault,
        outputMint,
        SPL_TOKEN_PROGRAM
      )
    );
  }

  const plan = await buildTopLevelRoute({
    inputMint: mint,
    outputMint,
    amount: position.amountRaw,
    taker: walletAddress,
    platformFeeBps: config.swapFeeBps,
    feeAccount: feeAta,
    destinationTokenAccount: destinationAta,
  });

  const closeIx = await program.methods
    .closeEmpty(new BN(USER_MAX_FEE_LAMPORTS.toString()))
    .accounts({
      user: walletAddress,
      config: configKey,
      stats: statsKey,
      source,
      mint,
      protocolVault: vault,
      tokenProgram: tokenProgramId,
    })
    .instruction();

  // Jupiter instructions remain top-level, so their data is stored only once.
  for (const b of plan.computeBudgetInstructions) instructions.push(toTxInstruction(b));
  for (const ix of plan.otherInstructions) instructions.push(toTxInstruction(ix));
  for (const ix of plan.setupInstructions) instructions.push(toTxInstruction(ix));
  instructions.push(toTxInstruction(plan.swapInstruction));
  if (plan.cleanupInstruction) instructions.push(toTxInstruction(plan.cleanupInstruction));
  instructions.push(closeIx);

  const lookupTables = Object.entries(plan.addressesByLookupTableAddress).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt("18446744073709551615"),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: addresses.map((address) => new PublicKey(address)),
        },
      })
  );
  return { instructions, plan, destinationAta, feeAta, lookupTables };
}

export interface PreflightResult {
  ok: boolean;
  message?: string;
}

/** Minimum lamports a wallet needs to cover network + priority fees. */
const MIN_FEE_LAMPORTS = 15_000;

/**
 * Fail-fast diagnostics before building/simulating anything: a 0-SOL wallet
 * or already-closed token accounts surface as cryptic "AccountNotFound"
 * during simulation. Check both up front and return actionable copy.
 */
export async function preflightWallet(
  connection: Connection,
  walletAddress: PublicKey,
  positions: Position[],
): Promise<PreflightResult> {
  const [balance, sourceInfos] = await Promise.all([
    connection.getBalance(walletAddress).catch(() => null),
    connection
      .getMultipleAccountsInfo(
        positions.map((p) => new PublicKey(p.tokenAccount)),
        "confirmed",
      )
      .catch(() => null),
  ]);
  if (balance === null) {
    return { ok: false, message: "RPC unavailable — could not verify your wallet before sending." };
  }
  if (balance < MIN_FEE_LAMPORTS) {
    const have = balance / 1e9;
    return {
      ok: false,
      message:
        `Your wallet has ${have.toFixed(6)} SOL — too little to pay network fees ` +
        `(~0.00002 SOL needed). Send a small amount of SOL to ${walletAddress.toBase58().slice(0, 6)}…${walletAddress.toBase58().slice(-6)} and retry.`,
    };
  }
  if (sourceInfos === null) {
    return { ok: false, message: "RPC unavailable — could not verify the accounts in this batch." };
  }
  const missing = positions.filter(
    (p, i) => !sourceInfos[i] || sourceInfos[i]!.data.length === 0,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `${missing.length} of ${positions.length} accounts no longer exist on-chain ` +
        `(already closed or reclaimed). Rescan your wallet to refresh the list before retrying.`,
    };
  }
  return { ok: true };
}

/** Build the close/burn instructions for a batch of positions. */
export async function buildCloseBurnInstructions(
  program: Program<DustCollector>,
  positions: Position[],
  walletAddress: PublicKey
): Promise<TransactionInstruction[]> {
  const configKey = configPda();
  const statsKey = statsPda();
  const vault = vaultPda();
  const out: TransactionInstruction[] = [];
  for (const position of positions) {
    const source = new PublicKey(position.tokenAccount);
    const mint = new PublicKey(position.mint);
    const tokenProgramId = new PublicKey(position.tokenProgramId);
    const accounts = {
      user: walletAddress,
      config: configKey,
      stats: statsKey,
      source,
      mint,
      protocolVault: vault,
      tokenProgram: tokenProgramId,
    };
    const ix =
      position.action === "close"
        ? await program.methods
            .closeEmpty(new BN(USER_MAX_FEE_LAMPORTS.toString()))
            .accounts(accounts)
            .instruction()
        : await program.methods
            .burnAndClose(new BN(USER_MAX_FEE_LAMPORTS.toString()))
            .accounts(accounts)
            .instruction();
    out.push(ix);
  }
  return out;
}

/** Batch close/burn positions into transaction-sized groups (mirror plan_transactions). */
export function batchPositions(positions: Position[]): Position[][] {
  const batches: Position[][] = [];
  for (let i = 0; i < positions.length; i += BATCH_SIZE) {
    batches.push(positions.slice(i, i + BATCH_SIZE));
  }
  return batches;
}

export interface PrepareOptions {
  connection: Connection;
  instructions: TransactionInstruction[];
  walletAddress: PublicKey;
  label: string;
  lookupTables?: AddressLookupTableAccount[];
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface PreparedTransaction {
  transaction: VersionedTransaction;
  label: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Build and simulate a transaction without asking the wallet to sign it. */
export async function prepareInstructions(opts: PrepareOptions): Promise<PreparedTransaction> {
  const {
    connection, instructions, walletAddress, label,
    lookupTables = [], blockhash, lastValidBlockHeight,
  } = opts;
  const message = new TransactionMessage({
    payerKey: walletAddress,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  const size = transaction.serialize().length;
  if (size > MAX_TX_SIZE) {
    throw new Error(
      `${label}: v0 transaction is ${size} bytes — exceeds Solana's ${MAX_TX_SIZE}-byte wire limit.`
    );
  }
  const sim = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    commitment: "confirmed",
  });
  if (sim.value.err) {
    const errStr =
      typeof sim.value.err === "string"
        ? sim.value.err
        : JSON.stringify(sim.value.err);
    let hint = "";
    if (/AccountNotFound/.test(errStr)) {
      hint =
        " — an account in this transaction no longer exists (already closed, or the wallet has 0 SOL). Rescan and retry.";
    } else if (/insufficient lamports|InsufficientFundsForRent/i.test(errStr)) {
      hint = " — your wallet needs more SOL to cover fees/rent.";
    } else if (/BlockhashNotFound/.test(errStr)) {
      hint = " — blockhash expired, retry.";
    } else if (/0x[0-9a-f]+/.test(errStr)) {
      hint = " — protocol rejected the instruction (on-chain error).";
    }
    const logs = (sim.value.logs ?? [])
      .filter((l) => l.includes("Program log:") || l.includes(" failed:"))
      .slice(-12);
    const detail = logs.length ? logs.join(" | ") : errStr;
    throw new Error(`${label}: simulation failed — ${detail}${hint}`);
  }
  return { transaction, label, blockhash, lastValidBlockHeight };
}

/** Submit one transaction from a wallet-signed batch and verify confirmation.
 * Confirmation is bounded: a hanging confirmTransaction (flaky RPC) must not
 * leave the UI stuck at "Sending…" after the tx already landed on-chain. */
export async function sendPreparedTransaction(
  connection: Connection,
  prepared: PreparedTransaction,
  signed: VersionedTransaction,
): Promise<string> {
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: true,
    preflightCommitment: "confirmed",
  });
  const CONFIRM_TIMEOUT_MS = 45_000;
  const POLL_INTERVAL_MS = 2_000;
  const POLL_ATTEMPTS = 15;

  const confirmation = await Promise.race([
    connection
      .confirmTransaction(
        {
          signature,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
        },
        "confirmed"
      )
      .then((v) => v as Awaited<ReturnType<Connection["confirmTransaction"]>> | null),
    new Promise<null>((resolve) =>
      window.setTimeout(() => resolve(null), CONFIRM_TIMEOUT_MS)
    ),
  ]);

  if (!confirmation) {
    // confirmTransaction hung (RPC stall) — poll signature status directly.
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const statuses = await connection
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .catch(() => null);
      const status = statuses?.value?.[0] ?? null;
      if (status && status.confirmations !== null) {
        if (status.err) {
          const txInfo = await connection
            .getTransaction(signature, { commitment: "confirmed" })
            .catch(() => null);
          const logs = (txInfo?.meta?.logMessages ?? [])
            .filter((l) => l.includes("Program log:"))
            .slice(-4);
          const detail = logs.length ? logs.join(" | ") : JSON.stringify(status.err);
          const err = new Error(
            `${prepared.label}: transaction failed on-chain (confirmed but errored) — ${detail}`
          );
          (err as Error & { signature?: string }).signature = signature;
          throw err;
        }
        return signature;
      }
      await new Promise((r) => window.setTimeout(r, POLL_INTERVAL_MS));
    }
    // Last resort: the tx may be confirmed but status polling was rate-limited.
    const txInfo = await connection
      .getTransaction(signature, { commitment: "confirmed" })
      .catch(() => null);
    if (txInfo) {
      if (txInfo.meta?.err) {
        const logs = (txInfo.meta?.logMessages ?? [])
          .filter((l) => l.includes("Program log:"))
          .slice(-4);
        const err = new Error(
          `${prepared.label}: transaction failed on-chain (confirmed but errored) — ${logs.join(" | ") || JSON.stringify(txInfo.meta.err)}`
        );
        (err as Error & { signature?: string }).signature = signature;
        throw err;
      }
      return signature;
    }
    const err = new Error(
      `${prepared.label}: could not confirm the transaction status — it may still be processing. Signature: ${signature}`
    );
    (err as Error & { signature?: string }).signature = signature;
    throw err;
  }

  if (confirmation.value.err) {
    // The tx was included in a block but FAILED on-chain (paused protocol,
    // route race, fee cap, ...). confirmTransaction resolves regardless of
    // success, so the error must be checked here — never report a failed tx
    // as success based on the signature alone.
    const txInfo = await connection
      .getTransaction(signature, { commitment: "confirmed" })
      .catch(() => null);
    const logs = (txInfo?.meta?.logMessages ?? [])
      .filter((l) => l.includes("Program log:"))
      .slice(-4);
    const detail = logs.length
      ? logs.join(" | ")
      : JSON.stringify(confirmation.value.err);
    const err = new Error(
      `${prepared.label}: transaction failed on-chain (confirmed but errored) — ${detail}`
    );
    // Keep the signature so the UI can link to the Explorer even on failure.
    (err as Error & { signature?: string }).signature = signature;
    throw err;
  }
  return signature;
}

export async function recentBlockhashOf(connection: Connection) {
  return connection.getLatestBlockhash("confirmed");
}
