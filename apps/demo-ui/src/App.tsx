import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import idl from "../../../target/idl/dust_collector.json";
import type { DustCollector } from "../../../target/types/dust_collector";
import type {
  ActionKind,
  ConfigView,
  ConfigStatus,
  DemoStage,
  Position,
  ThresholdMode,
  TxResult,
} from "./lib/types";
import {
  scanTokenAccounts,
  jupiterBuild,
  solPerOutputUnit,
  fetchPrices,
  fetchTokenMeta,
  type ScanProgress,
} from "./lib/api";
import { classifyPosition, boundedFee } from "./lib/classify";
import {
  buildCloseBurnInstructions,
  buildSwapInstructions,
  batchPositions,
  prepareInstructions,
  sendPreparedTransaction,
} from "./lib/executor";
import {
  configPda,
  PROGRAM_ID,
  RPC_URL,
  LAMPORTS_PER_SOL,
  EXPLORER_URL,
  USDC_MINT,
  USDT_MINT,
  SOL_MINT,
  USER_MAX_FEE_LAMPORTS,
  SWAP_MAX_ACCOUNTS_TRIES,
} from "./lib/constants";
import {
  fetchOnChainTokenMeta,
  resolveMetadataIcons,
  shortMint,
  type TokenMeta,
} from "./lib/token-meta";
import {
  capture,
  identifyWallet,
  initObservability,
  markMs,
  newScanId,
  shortWallet,
} from "./lib/observability";

const ACTION_LABEL: Record<ActionKind, string> = {
  close: "Recover SOL",
  burn: "Remove + Recover",
  swap: "Convert",
  keep: "Keep",
  unsupported: "Protected",
};

type ReviewGroup =
  | "recover"
  | "convert"
  | "keep"
  | "protected"
  | "unknown"
  | "remove";

const GROUP_ORDER: ReviewGroup[] = [
  "recover",
  "convert",
  "keep",
  "protected",
  "unknown",
  "remove",
];

const GROUP_META: Record<
  ReviewGroup,
  { icon: string; title: string; sub: string }
> = {
  recover: {
    icon: "◎",
    title: "READY TO RECOVER",
    sub: "Empty accounts — safe to close",
  },
  convert: {
    icon: "⇄",
    title: "WORTH CONVERTING",
    sub: "Small balances with usable swap routes",
  },
  keep: {
    icon: "◆",
    title: "ABOVE THRESHOLD",
    sub: "Not dust — above your tidy threshold, left untouched",
  },
  protected: {
    icon: "🛡",
    title: "PROTECTED",
    sub: "Protocol positions, claims, and special assets",
  },
  unknown: {
    icon: "?",
    title: "UNKNOWN",
    sub: "Tidify isn't confident enough to recommend an action",
  },
  remove: {
    icon: "🔥",
    title: "DUST TO REMOVE",
    sub: "Permanent destruction — review manually",
  },
};

/** Safety hierarchy: recover/convert are economic actions; remove is destructive. */
function groupOf(position: Position): ReviewGroup {
  switch (position.action) {
    case "close":
      return "recover";
    case "swap":
      return "convert";
    case "burn":
      return "remove";
    case "unsupported":
      return "protected";
    case "keep":
      return position.valueUsdc === null ? "unknown" : "keep";
  }
}

/** Circular token icon: real logo when available, otherwise a letter chip. */
function TokenAvatar({
  logo,
  symbol,
}: {
  logo?: string | null;
  symbol: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = !!logo && !failed;
  return (
    <span className={`token-avatar ${symbol.toLowerCase().slice(0, 8) || "t"}`}>
      {showImg ? (
        <img
          src={logo}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        symbol.slice(0, 1) || "?"
      )}
    </span>
  );
}

const OUTPUT_CURRENCY_OPTIONS: { label: string; sub: string; mint: string; icon: string }[] = [
  {
    label: "USDC",
    sub: "Stablecoin output",
    mint: USDC_MINT.toBase58(),
    icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
  },
  {
    label: "USDT",
    sub: "Stablecoin output",
    mint: USDT_MINT.toBase58(),
    icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg",
  },
];

const usd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: 4,
  }).format(value);

const short = (value: string) =>
  value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

function formatScanEta(seconds: number | null, assetCount: number): string {
  if (seconds !== null) {
    if (seconds < 5) return "Finishing up — less than 5s left.";
    if (seconds < 60) return `About ${seconds}s left.`;
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `About ${minutes} minute${minutes === 1 ? "" : "s"} left.`;
  }
  if (assetCount >= 1000) return "Large wallet detected — likely 1–3 minutes. Coffee is optional; panic is not.";
  if (assetCount >= 300) return "Busy wallet detected — likely 30–90 seconds. We are counting the dust bunnies.";
  if (assetCount >= 80) return "Moderate wallet — likely 15–45 seconds.";
  return "Usually under 15 seconds.";
}

function scanMood(assetCount: number, ratio: number): string {
  if (assetCount >= 1000) {
    if (ratio < 0.25) return "This wallet brought a whole attic. Sorting carefully.";
    if (ratio < 0.6) return "Still alive — just negotiating with 1,000+ ATAs.";
    return "Almost through the token archaeology.";
  }
  if (assetCount >= 300) return "Dust herd spotted. Rounding it up.";
  if (ratio > 0.7) return "Almost there.";
  return "Scanning safely.";
}

const timeAgo = (blockTime: number | null): string => {
  if (blockTime === null) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - blockTime);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

// Conservative product benchmark: one manual swap or rent-reclaim action takes
// roughly one minute. Always present this as an estimate.
const estimatedTimeSaved = (accounts: number) => {
  const minutes = accounts;
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours.toFixed(hours < 10 && !Number.isInteger(hours) ? 1 : 0)} hr`;
};

function App() {
  const wallet = useWallet();
  const connected = !!wallet.connected && !!wallet.publicKey;
  const walletAddress = wallet.publicKey ?? null;

  const [stage, setStage] = useState<DemoStage>("setup");
  const [configStatus, setConfigStatus] = useState<ConfigStatus>("loading");
  const [config, setConfig] = useState<ConfigView | null>(null);
  // Latest program transaction, surfaced on the hero as a live Orb link.
  const [lastTx, setLastTx] = useState<{
    signature: string;
    blockTime: number | null;
  } | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [heliusLatency, setHeliusLatency] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanPhase, setScanPhase] = useState(0);
  const [scanAssetCount, setScanAssetCount] = useState(0);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [scanProgressText, setScanProgressText] = useState("Preparing scan…");
  const [scanProgressRatio, setScanProgressRatio] = useState(0);
  const [scanEtaSeconds, setScanEtaSeconds] = useState<number | null>(null);
  const scanEtaText = formatScanEta(scanEtaSeconds, scanAssetCount);
  const scanMoodText = scanMood(scanAssetCount, scanProgressRatio);
  const [thresholdMode, setThresholdMode] = useState<ThresholdMode>("fixed");
  const [fixedThreshold, setFixedThreshold] = useState(5);
  const [portfolioPercent, setPortfolioPercent] = useState(1);
  const [outputMint, setOutputMint] = useState<string>(USDC_MINT.toBase58());
  const [outputOpen, setOutputOpen] = useState(false);
  const [positions, setPositions] = useState<Position[]>([]);
  const [portfolioValueUsdc, setPortfolioValueUsdc] = useState(0);
  const [solPrice, setSolPrice] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [burnConfirmed, setBurnConfirmed] = useState(false);
  // Review-screen group collapse state: low-priority groups start collapsed.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(["keep", "protected", "unknown"]),
  );
  const toggleGroup = (group: ReviewGroup) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const [progress, setProgress] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [currentSig, setCurrentSig] = useState<string | null>(null);
  const [results, setResults] = useState<TxResult[]>([]);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [brandNudge, setBrandNudge] = useState(false);
  // Auto-scan on connect: runs once per mounted session per wallet so a
  // connect immediately produces value instead of leaving the user at a
  // static "Scan wallet" button. Cleared on disconnect.
  const autoScannedWallet = useRef<string | null>(null);
  // Guest preview: estimate ANY wallet before connecting (read-only).
  const [guestAddress, setGuestAddress] = useState("");
  const [guestChecking, setGuestChecking] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const [guestResult, setGuestResult] = useState<{
    list: Position[];
    portfolioUsdc: number;
    solUsd: number;
    config: ConfigView | null;
  } | null>(null);
  const [guestScanSource, setGuestScanSource] = useState<"user_wallet" | "real_wallet_example">("user_wallet");
  // Async on-chain metadata icons (mint -> logo URL) resolved after a scan;
  // positions render the letter avatar until an icon arrives.
  const [logoOverrides, setLogoOverrides] = useState<Record<string, string>>({});

  const connection = useMemo(() => new Connection(RPC_URL, "confirmed"), []);

  useEffect(() => {
    void initObservability();
  }, []);

  useEffect(() => {
    if (walletAddress) identifyWallet(walletAddress.toBase58());
  }, [walletAddress]);

  // Small background health check for the header. It never blocks rendering or
  // wallet actions and refreshes infrequently to avoid unnecessary RPC load.
  useEffect(() => {
    let cancelled = false;
    const measure = async () => {
      const started = performance.now();
      try {
        const res = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "tidify-health",
            method: "getLatestBlockhash",
            params: [{ commitment: "processed" }],
          }),
        });
        if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
        await res.json();
        if (!cancelled) setHeliusLatency(Math.max(1, Math.round(performance.now() - started)));
      } catch {
        if (!cancelled) setHeliusLatency(null);
      }
    };
    void measure();
    const timer = window.setInterval(measure, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const program = useMemo(() => {
    if (!connected || !wallet.signTransaction || !wallet.signAllTransactions || !wallet.publicKey)
      return null;
    const provider = new AnchorProvider(
      connection,
      {
        publicKey: wallet.publicKey,
        signTransaction: <T extends Transaction | import("@solana/web3.js").VersionedTransaction>(tx: T) =>
          wallet.signTransaction!(tx as Transaction) as Promise<T>,
        signAllTransactions: <T extends Transaction | import("@solana/web3.js").VersionedTransaction>(txs: T[]) =>
          wallet.signAllTransactions!(txs as Transaction[]) as Promise<T[]>,
      },
      { commitment: "confirmed" }
    );
    return new Program<DustCollector>(idl as unknown as DustCollector, provider);
  }, [connected, wallet, connection]);

  // Read-only Program for the guest preview: reads the Config PDA without a
  // connected wallet. Signing methods are never called by account.fetch.
  const readOnlyProgram = useMemo(() => {
    const dummyWallet = {
      publicKey: PublicKey.unique(),
      signTransaction: async (_tx: unknown) => {
        throw new Error("read-only provider");
      },
      signAllTransactions: async (_txs: unknown[]) => {
        throw new Error("read-only provider");
      },
    } as any;
    const provider = new AnchorProvider(connection, dummyWallet, {
      commitment: "confirmed",
    });
    return new Program<DustCollector>(idl as unknown as DustCollector, provider);
  }, [connection]);

  // The hero also links to the most recent on-chain program activity. One cheap RPC
  // call — getSignaturesForAddress, limit 1 — no index, no server involved.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, {
          limit: 1,
        });
        if (cancelled || sigs.length === 0) return;
        setLastTx({
          signature: sigs[0].signature,
          blockTime: sigs[0].blockTime ?? null,
        });
      } catch {
        // leave null — the hero falls back to the program page link
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  // Load the on-chain Config PDA whenever the wallet/program changes.
  useEffect(() => {
    let cancelled = false;
    if (!program) {
      setConfigStatus("loading");
      setConfig(null);
      return;
    }
    (async () => {
      // Retry with backoff: public RPC endpoints rate-limit aggressively and
      // a transient 429 must not be reported as "protocol not initialized".
      // This is the gate for execution, so it has to be reliable for
      // independent users on whatever RPC the build points at.
      let lastErr: unknown = null;
      const delays = [900, 1800, 3600, 5000];
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          const raw = await program.account.config.fetch(configPda());
          if (cancelled) return;
          setConfig({
            admin: raw.admin.toBase58(),
            protocolVault: raw.protocolVault.toBase58(),
            closeFeeBps: raw.closeFeeBps,
            closeMinFeeLamports: BigInt(raw.closeMinFeeLamports.toString()),
            closeMaxFeeLamports: BigInt(raw.closeMaxFeeLamports.toString()),
            swapFeeBps: raw.swapFeeBps,
            swapMaxFeeBps: raw.swapMaxFeeBps,
            jupiterProgram: raw.jupiterProgram.toBase58(),
            paused: raw.paused,
          });
          setConfigStatus("ok");
          return;
        } catch (e) {
          lastErr = e;
          if (attempt < delays.length) {
            await new Promise((r) => setTimeout(r, delays[attempt]));
          }
        }
      }
      if (cancelled) return;
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      console.warn("config fetch failed:", msg);
      setConfig(null);
      // "Account does not exist" = genuinely not initialized; anything else
      // (429, timeout, network) = transient RPC problem, not a missing config.
      if (/does not exist|AccountNotFound|not found/i.test(msg)) {
        setConfigStatus("missing");
      } else {
        setConfigStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [program]);

  // Real SOL balance for the connected wallet.
  useEffect(() => {
    if (!walletAddress) {
      setSolBalance(null);
      return;
    }
    let cancelled = false;
    connection
      .getBalance(walletAddress)
      .then((b) => !cancelled && setSolBalance(b / 1e9))
      .catch(() => !cancelled && setSolBalance(null));
    return () => {
      cancelled = true;
    };
  }, [walletAddress, connection]);

  const threshold =
    thresholdMode === "fixed"
      ? fixedThreshold
      : (portfolioValueUsdc * portfolioPercent) / 100;

  // Output-currency display: portfolio + threshold denominated in the selected
  // currency (SOL uses the live SOL/USD price from the scan; stables ~1:1).
  const outputCurrency =
    OUTPUT_CURRENCY_OPTIONS.find((o) => o.mint === outputMint) ??
    OUTPUT_CURRENCY_OPTIONS[0];
  // The destination choices are stablecoins, so their display value is
  // denominated 1:1 in USDC terms. Live Jupiter quotes determine execution.
  const outputPriceUsdc = 1;
  const portfolioOutput =
    outputPriceUsdc > 0 ? portfolioValueUsdc / outputPriceUsdc : 0;
  const thresholdOutput =
    outputPriceUsdc > 0 ? threshold / outputPriceUsdc : 0;
  const fmtOutput = (v: number) =>
    `${v.toLocaleString("en-US", {
      minimumFractionDigits: v > 0 && v < 0.01 ? 4 : 0,
      maximumFractionDigits: v < 0.01 ? 4 : 2,
    })} ${outputCurrency.label}`;
  const fmtRecovery = (valueUsd: number) =>
    outputPriceUsdc > 0 ? fmtOutput(valueUsd / outputPriceUsdc) : "Unavailable";

  const classified = useMemo(
    () =>
      positions.map((position) => {
        if (position.action === "unsupported" || position.valueUsdc === null) return position;
        if (position.action === "close") return position;
        if (position.valueUsdc > threshold) {
          return {
            ...position,
            action: "keep" as const,
            actionReason: `Its value is above your ${usd(threshold)} tidy threshold.`,
          };
        }
        return position;
      }),
    [positions, threshold],
  );

  const groups = useMemo(() => {
    const acc: Record<ReviewGroup, Position[]> = {
      recover: [],
      convert: [],
      keep: [],
      protected: [],
      unknown: [],
      remove: [],
    };
    for (const position of classified) acc[groupOf(position)].push(position);
    return acc;
  }, [classified]);

  const selectedPositions = classified.filter(
    (position) =>
      selected.has(position.id) && position.action !== "keep" && position.action !== "unsupported",
  );
  const selectedBurns = selectedPositions.filter((position) => position.action === "burn");
  const swapPositions = selectedPositions.filter((position) => position.action === "swap");
  const closeBurnPositions = selectedPositions.filter(
    (position) => position.action === "close" || position.action === "burn",
  );
  const closeBurnBatches = batchPositions(closeBurnPositions);
  const transactionCount = closeBurnBatches.length + swapPositions.length;
  const failedCount = results.filter((result) => result.error).length;
  const confirmedCount = results.length - failedCount;
  const confirmedPositionCount = results
    .filter((result) => !result.error)
    .reduce((n, result) => n + result.positionIds.length, 0);

  const totals = useMemo(() => {
    let rent = 0;
    let netUsd = 0;
    let feesUsd = 0;
    for (const position of selectedPositions) {
      rent += position.rentLamports / 1e9;
      if (position.action === "swap") {
        netUsd += ((position.netRecoveryLamports / Number(LAMPORTS_PER_SOL)) * solPrice);
        feesUsd += position.swapFeeUsdc ?? 0;
      } else {
        netUsd += ((position.netRecoveryLamports / Number(LAMPORTS_PER_SOL)) * solPrice);
        feesUsd += ((position.protocolFeeLamports ?? 0) / Number(LAMPORTS_PER_SOL)) * solPrice;
      }
    }
    return { rent, netUsd, feesUsd };
  }, [selectedPositions, solPrice]);
  const recoveryBreakdown = useMemo(() => {
    const swap = swapPositions.reduce(
      (sum, position) =>
        sum +
        (position.netRecoveryLamports / Number(LAMPORTS_PER_SOL)) * solPrice,
      0,
    );
    const rent = selectedPositions.reduce(
      (sum, position) => sum + (position.rentLamports / 1e9) * solPrice,
      0,
    );
    return { swap, rent };
  }, [swapPositions, selectedPositions, solPrice]);
  // Protocol fees are charged in SOL on-chain — surface them in SOL with the
  // live SOL/USDC quote alongside, so "0 USDC" is never shown when only rent
  // is being recovered.
  const feesSol = solPrice > 0 ? totals.feesUsd / solPrice : 0;

  // Shared scan -> price -> quote -> classify pipeline. Used by the connected
  // flow (scan) and by the guest preview (guestCheck) for ANY address.
  const analyzeWallet = useCallback(
    async (
      owner: PublicKey,
      cfg: ConfigView | null,
      output: string,
      onProgress?: (phase: number, assetCount?: number, detail?: ScanProgress) => void,
    ): Promise<{ list: Position[]; portfolioUsdc: number; solUsd: number }> => {
      const rpcStarted = performance.now();
      const scanned = await scanTokenAccounts(connection, owner, (detail) => {
        onProgress?.(0, undefined, detail);
      });
      const rpcMs = markMs(rpcStarted);
      onProgress?.(1, scanned.length);
      const pricingStarted = performance.now();
      const prices = await fetchPrices(scanned.map((s) => s.mint), true);
      const pricingMs = markMs(pricingStarted);
      const solUsd = prices.get("So11111111111111111111111111111111111111112") ?? 0;
      // Wrapped SOL token accounts represent native SOL, not collectible dust.
      // Exclude them before quoting/classification so they can never be proposed
      // for a Jupiter swap, burn, close, or user approval.
      const dustScanned = scanned.filter((s) => !s.mint.equals(SOL_MINT));
      const selectedOutputMint = new PublicKey(output);
      const perUnit = await solPerOutputUnit(owner, selectedOutputMint, prices);
      onProgress?.(2);
      // capture the narrowed non-null key for closures (TS re-widens in functions)
      const taker: PublicKey = owner;
      // On-chain metadata for mints the Jupiter list does not know (claim /
      // LP / airdrop tokens). Kicked off in parallel with the quote phase.
      const metaPromise = fetchTokenMeta().catch(() => null);
      let onChainMetaPromise: Promise<
        Map<string, { symbol: string; name: string }>
      > | null = null;
      metaPromise.then((jupiterMeta) => {
        const missing = dustScanned
          .filter((s) => !jupiterMeta?.has(s.mint.toBase58()))
          .map((s) => s.mint.toBase58());
        if (missing.length) {
          onChainMetaPromise = fetchOnChainTokenMeta(
            async (address) => {
              const info = await connection.getAccountInfo(
                new PublicKey(address)
              );
              return info
                ? { owner: info.owner.toBase58(), data: info.data }
                : null;
            },
            missing
          );
        }
      });

      const quotes = new Map<string, Awaited<ReturnType<typeof jupiterBuild>>>();
      const quoteable = dustScanned.filter(
        (s) =>
          s.supported &&
          s.canSwap &&
          s.amount > 0n &&
          s.mint.toBase58() !== output,
      );
      let idx = 0;
      const concurrency = 4;
      async function worker() {
        while (idx < quoteable.length) {
          const s = quoteable[idx++];
          try {
            // Try progressively SMALLER routes first (12 -> 48 accounts):
            // big multi-hop routes carry too many accounts for the 1232-byte
            // swap_and_close CPI, so a small route is preferable.
            let q: Awaited<ReturnType<typeof jupiterBuild>> | null = null;
            for (const maxAccounts of SWAP_MAX_ACCOUNTS_TRIES) {
              try {
                q = await jupiterBuild(
                  {
                    inputMint: s.mint,
                    outputMint: selectedOutputMint,
                    amount: s.amount,
                    taker,
                  },
                  maxAccounts
                );
                if (q) break;
              } catch {
                // try the next (larger) account budget
              }
            }
            if (q) quotes.set(s.pubkey.toBase58(), q);
          } catch {
            // no route -> burn path
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      onProgress?.(3);

      const meta = await metaPromise;
      const onChainMeta = await (onChainMetaPromise ??
        Promise.resolve(new Map<string, TokenMeta>()));

      // Best-effort icons: the curated list logo wins; tokens that only have
      // on-chain metadata resolve their metadata JSON image async (cached) and
      // upgrade from the letter avatar in place via logoOverrides.
      const iconEntries: { mint: string; uri: string }[] = [];
      for (const s of dustScanned) {
        const mintStr = s.mint.toBase58();
        const oc = onChainMeta.get(mintStr);
        if (!meta?.get(mintStr)?.logo && oc?.uri) {
          iconEntries.push({ mint: mintStr, uri: oc.uri });
        }
      }
      if (iconEntries.length) {
        void resolveMetadataIcons(iconEntries).then((byMint) => {
          if (!byMint.size) return;
          setLogoOverrides((prev) => {
            const next = { ...prev };
            for (const [m, l] of byMint) if (l) next[m] = l;
            return next;
          });
        });
      }

      const list: Position[] = dustScanned.map((s) => {
        const mintStr = s.mint.toBase58();
        const jupMeta = meta?.get(mintStr);
        const ocMeta = onChainMeta.get(mintStr);
        const metaHit = jupMeta ?? ocMeta;
        const positioned = classifyPosition({
          scanned: s,
          config: cfg,
          quote: quotes.get(s.pubkey.toBase58()) ?? null,
          solPerOutputUnit: perUnit,
          prices,
          excludedMints: new Set([output]),
        });
        if (metaHit) {
          positioned.symbol = metaHit.symbol;
          positioned.name = metaHit.name;
          positioned.logo = jupMeta?.logo;
        } else {
          // No metadata anywhere: show an identifiable mint prefix and say
          // plainly that the token is unverified — never a meaningless 4-char
          // code that hides what the user is about to swap away.
          positioned.symbol = shortMint(mintStr);
          if (positioned.name === "Token") {
            positioned.name = "Unverified token";
          }
        }
        return positioned;
      });

      const portfolioUsdc = list.reduce((sum, p) => sum + (p.valueUsdc ?? 0), 0);
      onProgress?.(4);
      (window as any).__tidifyLastTimings = {
        rpc_ms: rpcMs,
        pricing_ms: pricingMs,
        token_count: scanned.length,
        redeemable_count: list.filter((p) => p.action === "close" || p.action === "swap" || p.action === "burn").length,
      };
      return { list, portfolioUsdc, solUsd };
    },
    [connection],
  );

  // Fetch the on-chain Config with retry/backoff — shared by the connected
  // config effect and the guest preview (read-only).
  const fetchConfigView = useCallback(
    async (prog: Program<DustCollector>): Promise<ConfigView> => {
      let lastErr: unknown = null;
      const delays = [900, 1800, 3600, 5000];
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          const raw = await prog.account.config.fetch(configPda());
          return {
            admin: raw.admin.toBase58(),
            protocolVault: raw.protocolVault.toBase58(),
            closeFeeBps: raw.closeFeeBps,
            closeMinFeeLamports: BigInt(raw.closeMinFeeLamports.toString()),
            closeMaxFeeLamports: BigInt(raw.closeMaxFeeLamports.toString()),
            swapFeeBps: raw.swapFeeBps,
            swapMaxFeeBps: raw.swapMaxFeeBps,
            jupiterProgram: raw.jupiterProgram.toBase58(),
            paused: raw.paused,
          };
        } catch (e) {
          lastErr = e;
          if (attempt < delays.length) {
            await new Promise((r) => setTimeout(r, delays[attempt]));
          }
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
    [],
  );

  // Guest preview: estimate what any wallet could redeem, without connecting.
  const guestCheck = useCallback(async (source: "user_wallet" | "real_wallet_example" = guestScanSource) => {
    const scanId = newScanId();
    const totalStarted = performance.now();
    capture(source === "real_wallet_example" ? "real_wallet_example_scan_clicked" : "user_wallet_scan_clicked", {
      scan_id: scanId,
      mode: connected ? "connected" : "guest",
      source,
    });
    capture("scan_cta_clicked", { scan_id: scanId, mode: connected ? "connected" : "guest", source });
    capture("scan_started", { scan_id: scanId, mode: "guest", source });
    const trimmed = guestAddress.trim();
    let owner: PublicKey;
    try {
      owner = new PublicKey(trimmed);
      capture("wallet_address_entered", {
        scan_id: scanId,
        wallet: owner.toBase58(),
        wallet_short: shortWallet(owner.toBase58()),
      });
    } catch {
      capture("scan_failed", { scan_id: scanId, mode: "guest", error_kind: "invalid_wallet" });
      setGuestError(
        "That doesn't look like a valid Solana wallet address. Paste the address from your wallet's receive screen.",
      );
      return;
    }
    setGuestChecking(true);
    setGuestError(null);
    setGuestResult(null);
    try {
      let cfg: ConfigView | null = null;
      try {
        cfg = await fetchConfigView(readOnlyProgram);
      } catch {
        cfg = null; // protocol not initialized (or RPC down) — classify uses defaults
      }
      const { list, portfolioUsdc, solUsd } = await analyzeWallet(owner, cfg, outputMint);
      setGuestResult({ list, portfolioUsdc, solUsd, config: cfg });
      const timings = (window as any).__tidifyLastTimings ?? {};
      capture("scan_completed", {
        scan_id: scanId,
        mode: "guest",
        total_ms: markMs(totalStarted),
        ...timings,
      });
    } catch (e) {
      capture("scan_failed", {
        scan_id: scanId,
        mode: "guest",
        total_ms: markMs(totalStarted),
        error_kind: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
      });
      setGuestError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuestChecking(false);
    }
  }, [guestAddress, readOnlyProgram, fetchConfigView, analyzeWallet, outputMint, connected, guestScanSource]);

  const scan = useCallback(async () => {
    if (!walletAddress || !program) return;
    const scanId = newScanId();
    const totalStarted = performance.now();
    capture("scan_started", {
      scan_id: scanId,
      mode: "connected",
      wallet: walletAddress.toBase58(),
      wallet_short: shortWallet(walletAddress.toBase58()),
    });
    setScanning(true);
    setScanStartedAt(totalStarted);
    setScanPhase(0);
    setScanAssetCount(0);
    setScanProgressText("Starting wallet scan…");
    setScanProgressRatio(0.04);
    setScanEtaSeconds(null);
    setFatalError(null);
    try {
      const { list, portfolioUsdc, solUsd } = await analyzeWallet(
        walletAddress,
        config,
        outputMint,
        (phase, assetCount, detail) => {
          setScanPhase(phase);
          if (assetCount !== undefined) setScanAssetCount(assetCount);
          if (detail) {
            setScanProgressText(detail.message);
            const ratio = detail.total > 0 ? Math.min(0.45, 0.08 + (detail.done / detail.total) * 0.37) : 0.08;
            setScanProgressRatio(ratio);
            if (scanStartedAt) {
              const elapsed = (performance.now() - scanStartedAt) / 1000;
              setScanEtaSeconds(ratio > 0.05 && ratio < 0.95 ? Math.max(1, Math.round((elapsed / ratio) - elapsed)) : null);
            }
          }
        },
      );
      setSolPrice(solUsd);
      setPortfolioValueUsdc(portfolioUsdc);

      // Hide balances in the selected output currency (USDC/USDT/SOL) from the
      // dust list entirely — they are destinations, never candidates. They still
      // count toward the portfolio value used by the percentage threshold.
      const dustList = list.filter((p) => p.mint !== outputMint);
      setPositions(dustList);
      // default selection: close + swap below the effective threshold
      const defaultSelected = new Set(
        dustList
          .filter(
            (p) =>
              (p.action === "close" || p.action === "swap") &&
              (p.valueUsdc === null || p.valueUsdc <= threshold),
          )
          .map((p) => p.id),
      );
      setSelected(defaultSelected);
      setStage("review");
      capture("plan_opened", { scan_id: scanId, position_count: dustList.length, selected_count: defaultSelected.size });
      const timings = (window as any).__tidifyLastTimings ?? {};
      capture("scan_completed", {
        scan_id: scanId,
        mode: "connected",
        total_ms: markMs(totalStarted),
        position_count: dustList.length,
        selected_count: defaultSelected.size,
        ...timings,
      });
    } catch (e) {
      capture("scan_failed", {
        scan_id: scanId,
        mode: "connected",
        total_ms: markMs(totalStarted),
        error_kind: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
      });
      setFatalError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
      setScanStartedAt(null);
      setScanEtaSeconds(null);
    }
  }, [walletAddress, program, config, threshold, outputMint, analyzeWallet]);

  // After connect, kick off a scan automatically so the connected wallet
  // immediately shows a plan instead of parking at a manual button. Runs once
  // per mounted session per wallet; a fresh page load counts as a new session.
  useEffect(() => {
    if (!walletAddress || !program) return;
    if (autoScannedWallet.current === walletAddress.toBase58()) return;
    if (stage !== "setup" || scanning || positions.length > 0) return;
    const timer = window.setTimeout(() => {
      autoScannedWallet.current = walletAddress.toBase58();
      capture("auto_scan_triggered", { wallet_short: shortWallet(walletAddress.toBase58()) });
      void scan();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [walletAddress, program, stage, scanning, positions, scan]);

  useEffect(() => {
    if (!walletAddress) autoScannedWallet.current = null;
  }, [walletAddress]);

  const scrollToScan = (step: string) => {
    capture("marketing_step_clicked", { step });
    document.querySelector(".setup-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const selectRecommended = () => {
    setSelected(
      new Set(
        classified
          .filter(
            (item) =>
              (item.action === "close" || item.action === "swap") &&
              (item.valueUsdc === null || item.valueUsdc <= threshold),
          )
          .map((item) => item.id),
      ),
    );
    setBurnConfirmed(false);
  };

  const togglePosition = (position: Position) => {
    if (position.action === "keep" || position.action === "unsupported") return;
    setSelected((current) => {
      const next = new Set(current);
      const wasSelected = next.has(position.id);
      if (wasSelected) next.delete(position.id);
      else next.add(position.id);
      capture(wasSelected ? "position_unselected" : "position_selected", {
        action: position.action,
        selected_count: next.size,
      });
      return next;
    });
    setBurnConfirmed(false);
  };

  const execute = async () => {
    if (!walletAddress || !program || !wallet.signAllTransactions) return;
    if (configStatus !== "ok" || !config) {
      setFatalError("Protocol config is not available on-chain; cannot execute.");
      return;
    }
    if (config.paused) {
      setFatalError(
        "Tidify is temporarily unavailable for transactions. Please try again later."
      );
      return;
    }
    setStage("processing");
    setResults([]);
    setFatalError(null);
    setProgress(0);
    const total = transactionCount;
    setProgressTotal(total);
    const txResults: TxResult[] = [];

    try {
      const plans: Array<{
        label: string;
        ids: string[];
        build: () => Promise<{
          instructions: TransactionInstruction[];
          lookupTables?: AddressLookupTableAccount[];
        }>;
      }> = [];
      for (const batch of closeBurnBatches) {
        const ids = batch.map((p) => p.id);
        plans.push({
          label: `close/burn batch (${batch.length} account${batch.length === 1 ? "" : "s"})`,
          ids,
          build: async () => ({
            instructions: await buildCloseBurnInstructions(program!, batch, walletAddress),
          }),
        });
      }
      for (const position of swapPositions) {
        plans.push({
          label: `swap ${position.symbol || short(position.mint)}`,
          ids: [position.id],
          build: async () => {
            const built = await buildSwapInstructions(
              program!,
              connection,
              position,
              config,
              walletAddress,
              new PublicKey(outputMint),
              new PublicKey(position.tokenProgramId),
            );
            return { instructions: built.instructions, lookupTables: built.lookupTables };
          },
        });
      }

      const builtPlans: Array<Awaited<ReturnType<(typeof plans)[number]["build"]>> & {
        label: string;
        ids: string[];
      }> = [];
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        setProgressLabel(`Building ${plan.label} (${i + 1}/${total})`);
        try {
          builtPlans.push({ ...(await plan.build()), label: plan.label, ids: plan.ids });
        } catch (e) {
          txResults.push({
            positionIds: plan.ids,
            label: plan.label,
            signature: "",
            error: e instanceof Error ? e.message : String(e),
            errorPhase: "build",
          });
        }
      }

      const validity = await connection.getLatestBlockhash("confirmed");
      const prepared: Array<{
        ids: string[];
        label: string;
        transaction: VersionedTransaction;
        blockhash: string;
        lastValidBlockHeight: number;
      }> = [];
      for (let i = 0; i < builtPlans.length; i++) {
        const item = builtPlans[i];
        setProgressLabel(`Simulating ${item.label} (${i + 1}/${builtPlans.length})`);
        try {
          prepared.push({
            ...(await prepareInstructions({
              connection,
              instructions: item.instructions,
              lookupTables: item.lookupTables,
              walletAddress,
              label: item.label,
              ...validity,
            })),
            ids: item.ids,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          txResults.push({
            positionIds: item.ids,
            label: item.label,
            signature: "",
            error: message,
            errorPhase: /wire limit/.test(message) ? "size" : "simulation",
          });
        }
      }

      if (prepared.length > 0) {
        setProgressLabel(`Approve all ${prepared.length} transaction${prepared.length === 1 ? "" : "s"} once in your wallet`);
        capture("signature_requested", { transaction_count: prepared.length });
        let signed: VersionedTransaction[];
        try {
          signed = await wallet.signAllTransactions(
            prepared.map((item) => item.transaction),
          ) as VersionedTransaction[];
        } catch (e) {
          capture("signature_cancelled", {
            transaction_count: prepared.length,
            error_kind: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
          });
          throw e;
        }
        for (let i = 0; i < prepared.length; i++) {
          const item = prepared[i];
          setProgressLabel(`Sending ${item.label} (${i + 1}/${prepared.length})`);
          try {
            capture("transaction_submitted", { label: item.label, position_count: item.ids.length });
            const signature = await sendPreparedTransaction(connection, item, signed[i]);
            setCurrentSig(signature);
            capture("transaction_confirmed", { label: item.label, position_count: item.ids.length });
            txResults.push({ positionIds: item.ids, label: item.label, signature });
          } catch (e) {
            capture("transaction_failed", {
              label: item.label,
              position_count: item.ids.length,
              error_kind: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
            });
            const err = e instanceof Error ? e : new Error(String(e));
            txResults.push({
              positionIds: item.ids,
              label: item.label,
              signature: (e as Error & { signature?: string }).signature ?? "",
              error: err.message,
              errorPhase: /failed on-chain/.test(err.message) ? "on-chain" : "send",
            });
          }
          setProgress(txResults.length);
        }
      }
    } catch (e) {
      setFatalError(e instanceof Error ? e.message : String(e));
    }
    setProgress(total);
    setProgressLabel("");
    setCurrentSig(null);
    setResults(txResults);
    setStage("complete");
  };

  const restart = () => {
    setStage("setup");
    setSelected(new Set());
    setBurnConfirmed(false);
    setProgress(0);
    setProgressTotal(0);
    setResults([]);
    setFatalError(null);
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <button
          className="brand"
          onClick={() => {
            if (stage === "setup") {
              capture("brand_clicked", { stage });
              setBrandNudge(true);
              window.setTimeout(() => setBrandNudge(false), 2200);
              window.scrollTo({ top: 0, behavior: "smooth" });
            } else {
              restart();
            }
          }}
          aria-label="Return to start"
        >
          <span className="brand-mark">tf</span>
          <span>
            <strong>Tidify</strong>
            <small>Solana token cleanup</small>
          </span>
        </button>
        <div className="header-actions">
          <a className="docs-link" href="/docs.html">Docs</a>
          <div className="network-pill live" title="Current Helius response time"><span /> HELIUS {heliusLatency === null ? "—" : heliusLatency} ms</div>
          <div className="wallet-button">
            <WalletMultiButton />
          </div>
        </div>
      </header>

      {brandNudge && (
        <div className="brand-nudge" role="status">
          You're at the start — paste a wallet or connect to begin.
        </div>
      )}

      <main>
        <nav className="steps" aria-label="Tidify progress">
          {["Scan", "Set threshold", "Review", "Approve", "Complete"].map((label, index) => {
            const activeIndex =
              stage === "setup"
                ? connected
                  ? 1
                  : 0
                : stage === "review"
                  ? 2
                  : stage === "confirm"
                    ? 3
                    : stage === "processing"
                      ? 3
                      : 4;
            // Backward navigation: an earlier step may be re-entered when the
            // data it needs exists. Forward steps and the current step are
            // display-only. Navigation is locked while transactions are
            // actually being sent.
            const backward = index < activeIndex;
            const navigable =
              backward &&
              stage !== "processing" &&
              (index === 0 ||
                index === 1 ||
                (index === 2 && positions.length > 0) ||
                (index === 3 &&
                  positions.length > 0 &&
                  selectedPositions.length > 0 &&
                  configStatus === "ok" &&
                  !config?.paused) ||
                (index === 4 && results.length > 0));
            return (
              <button
                type="button"
                className={`step ${index <= activeIndex ? "active" : ""} ${backward ? "back" : ""}`}
                key={label}
                onClick={() => {
                  if (!navigable) return;
                  if (index === 0 || index === 1) setStage("setup");
                  else if (index === 2) setStage("review");
                  else if (index === 3) setStage("confirm");
                  else if (index === 4) setStage("complete");
                }}
                disabled={!navigable}
                aria-label={navigable ? `Go back to: ${label}` : label}
              >
                <span>{index < activeIndex ? "✓" : index + 1}</span>{label}
              </button>
            );
          })}
        </nav>

        {stage === "setup" && (
          <section className="setup-grid enter">
            <div className="hero-card">
              <span className="eyebrow">MAKE THE SMALL STUFF USEFUL</span>
              <h1>Turn leftover tokens<br /><em>into usable value.</em></h1>
              <p>Paste a wallet first. Tidify estimates recoverable value read-only, then asks you to connect only after there is something worth cleaning up.</p>
              <div className="hero-metrics">
                <div>
                  {lastTx ? (
                    <a
                      className="hero-stat-link"
                      href={`${EXPLORER_URL}/tx/${lastTx.signature}`}
                      target="_blank"
                      rel="noreferrer"
                      title={lastTx.signature}
                    >
                      <strong>Latest activity ↗</strong>
                      <span>{short(lastTx.signature)} · {timeAgo(lastTx.blockTime)}</span>
                    </a>
                  ) : (
                    <a
                      className="hero-stat-link"
                      href={`${EXPLORER_URL}/program/${PROGRAM_ID.toBase58()}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <strong>Latest activity ↗</strong>
                      <span>View program on Orb</span>
                    </a>
                  )}
                </div>
                <div><strong>stats in progress</strong><span>not enough on-chain data yet</span></div>
                <div><strong>your control</strong><span>you approve every action</span></div>
              </div>
            </div>

            <div className="setup-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">01 / SCAN</span>
                  <h2>See how much your wallet can recover</h2>
                </div>
              </div>

              {!connected ? (
                <div className="preconnect-state">
                  <div className="guest-card primary-guest-card">
                    <p>Paste a Solana address to see how much value may be recoverable. No connection required.</p>
                    <div className="guest-input-row">
                      <input
                        type="text"
                        placeholder="Paste your Solana wallet address"
                        value={guestAddress}
                        onChange={(event) => { setGuestScanSource("user_wallet"); setGuestAddress(event.target.value); }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") guestCheck("user_wallet");
                        }}
                        disabled={guestChecking}
                        aria-label="Wallet address to scan"
                      />
                      <button className={guestAddress.trim() ? "primary scan-cta active" : "primary scan-cta"} onClick={() => guestCheck("user_wallet")} disabled={guestChecking}>
                        {guestChecking ? (
                          <>
                            <i className="spinner" /> Scanning…
                          </>
                        ) : (
                          <>Calculate Recovery <span>→</span></>
                        )}
                      </button>
                    </div>
                    <div className="trust-row">Public address only · No connection · No signing · Read-only</div>
                    <button
                      type="button"
                      className="demo-wallet-link"
                      onClick={() => {
                        capture("real_wallet_example_selected", { source: "primary_scan" });
                        setGuestScanSource("real_wallet_example");
                        setGuestAddress("E3VpEoP6AbJy68cjyg1ZHo6JUtojMZmJEYtqHaNEv1F7");
                      }}
                    >
                      <span>No address handy?</span>
                      <strong>Load sample address</strong>
                    </button>
                    {guestError && <div className="error-banner">{guestError}</div>}
                  </div>
                </div>
              ) : (
                <>
                  <div className="wallet-summary">
                    <div className="token-avatar purple">S</div>
                    <div>
                      <strong>{short(walletAddress!.toBase58())}</strong>
                      <span>
                        {solBalance === null ? "… SOL" : `${solBalance.toFixed(4)} SOL`}
                        {portfolioValueUsdc > 0 ? ` · ${fmtOutput(portfolioOutput)} in token value` : ""}
                      </span>
                    </div>
                    <span className="check">✓</span>
                  </div>

                  {(configStatus === "missing" || configStatus === "error") && (
                    <div className="config-warning">
                      Transaction services are temporarily unavailable. You can still preview your wallet and try again shortly.
                    </div>
                  )}

                  {scanning ? (
                    <div className="scan-event" role="status" aria-live="polite">
                      <div className="scan-radar"><strong>{scanAssetCount || "…"}</strong><span>assets</span></div>
                      <div className="scan-copy">
                        <strong>Analyzing your wallet</strong>
                        <small>{scanProgressText} · {scanEtaText}</small>
                        <em className="scan-joke">{scanMoodText}</em>
                        <div className="scan-progress-bar"><span style={{ width: `${Math.round(scanProgressRatio * 100)}%` }} /></div>
                        {[
                          "Scanning token subaccounts",
                          "Checking reclaimable rent",
                          "Checking liquidity",
                          "Calculating optimal actions",
                        ].map((label, index) => (
                          <div className={index < scanPhase ? "done" : index === scanPhase ? "active" : "waiting"} key={label}>
                            <span>{index < scanPhase ? "✓" : index === scanPhase ? "•" : "○"}</span>{label}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <button className="primary full scan-button" onClick={scan}>
                      Scan wallet <span>→</span>
                    </button>
                  )}
                  {fatalError && <div className="error-banner">{fatalError}</div>}
                </>
              )}

              {connected && (
                <div className="guest-card compact-guest-card">
                  <span className="eyebrow">READ-ONLY SCAN</span>
                  <h3>Check another wallet</h3>
                  <div className="guest-input-row">
                    <input type="text" placeholder="Solana wallet address" value={guestAddress} onChange={(event) => { setGuestScanSource("user_wallet"); setGuestAddress(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") guestCheck("user_wallet"); }} disabled={guestChecking} aria-label="Wallet address to scan" />
                    <button className="primary" onClick={() => guestCheck("user_wallet")} disabled={guestChecking}>{guestChecking ? <><i className="spinner" /> Scanning…</> : "Scan"}</button>
                  </div>
                  {guestError && <div className="error-banner">{guestError}</div>}
                </div>
              )}
              {guestResult &&
                  (() => {
                    const actionable = guestResult.list.filter(
                      (p) =>
                        p.action === "close" || p.action === "burn" || p.action === "swap",
                    );
                    const kept = guestResult.list.filter((p) => p.action === "keep");
                    const unsupported = guestResult.list.filter(
                      (p) => p.action === "unsupported",
                    );
                    const dustValue = actionable.reduce(
                      (sum, p) => sum + (p.valueUsdc ?? 0),
                      0,
                    );
                    const netRecoveryUsd =
                      (actionable.reduce((sum, p) => sum + p.netRecoveryLamports, 0) /
                        Number(LAMPORTS_PER_SOL)) *
                      guestResult.solUsd;
                    const rows = [...actionable].sort(
                      (a, b) => (b.valueUsdc ?? 0) - (a.valueUsdc ?? 0),
                    );
                    const SHOW = 15;
                    return (
                      <div className="guest-result">

                        <div className="guest-stats">
                          <div>
                            <span>Small-balance value</span>
                            <strong className="value-pop" key={`dust-${dustValue.toFixed(2)}`}>{usd(dustValue)}</strong>
                          </div>
                          <div>
                            <span>Estimated net recovery</span>
                            <strong className="value-pop" key={`net-${netRecoveryUsd.toFixed(2)}`}>{fmtRecovery(netRecoveryUsd)}</strong>
                          </div>
                          <div>
                            <span>Redeemable subaccounts</span>
                            <strong>{actionable.length}</strong>
                          </div>
                          <div className="time-stat">
                            <span>Estimated time saved</span>
                            <strong>{estimatedTimeSaved(actionable.length)}</strong>
                          </div>
                          <div>
                            <span>Close / Burn / Swap</span>
                            <strong>
                              {actionable.filter((p) => p.action === "close").length} /{" "}
                              {actionable.filter((p) => p.action === "burn").length} /{" "}
                              {actionable.filter((p) => p.action === "swap").length}
                            </strong>
                          </div>
                        </div>
                        {guestResult.config === null ? (
                          <div className="config-warning">
                            Live fee information is temporarily unavailable. This preview uses conservative estimates.
                          </div>
                        ) : guestResult.config.paused ? (
                          <div className="config-warning">
                            Transactions are temporarily unavailable. Please try again later.
                          </div>
                        ) : null}
                        {rows.length === 0 ? (
                          <div className="empty-state compact">
                            <strong>No accounts to tidy found</strong>
                            <p>
                              This wallet has no closable, burnable, or swappable balances under
                              the current settings.
                            </p>
                          </div>
                        ) : (
                          <div className="guest-rows">
                            {rows.slice(0, SHOW).map((p) => (
                              <div className="guest-row" key={p.id}>
                                <TokenAvatar
                                  logo={p.logo ?? logoOverrides[p.mint]}
                                  symbol={p.symbol}
                                />
                                <span className="guest-row-name">
                                  <strong>{p.symbol}</strong>
                                  <small>{p.name} · {p.amount}{p.amountRaw === 0n ? " · Verified 0" : ""}</small>
                                </span>
                                <span className="guest-row-value">
                                  {p.valueUsdc === null ? "Unknown" : usd(p.valueUsdc)}
                                </span>
                                <span className={`action-badge ${p.action}`}>
                                  <i />
                                  {ACTION_LABEL[p.action]}
                                </span>
                              </div>
                            ))}
                            {rows.length > SHOW && (
                              <div className="guest-more">
                                … and {rows.length - SHOW} more
                              </div>
                            )}
                          </div>
                        )}
                        <div className="guest-cta">
                          {connected
                            ? "The flow above can execute this exact plan for your own wallet."
                            : "Connect your wallet above to execute this plan."}
                        </div>
                      </div>
                    );
                  })()}
              {!connected && guestResult && (
                <div className="post-scan-connect">
                  <strong>Ready to clean it up?</strong>
                  <div className="post-scan-actions">
                    <span>Connect wallet only after the read-only scan shows value.</span>
                    <div className="wallet-button primary-wrap"><WalletMultiButton /></div>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {stage === "setup" && (
          <section className="marketing-sections" aria-label="About Tidify">
            <div className="marketing-block">
              <span className="eyebrow">HOW TIDIFY WORKS</span>
              <h2>From scattered dust to usable value</h2>
              <ol className="marketing-steps">
                <li onClick={() => scrollToScan("identify")}><strong>Identify.</strong> Tidify scans a wallet on Solana mainnet for empty token accounts and leftover dust balances — no signature needed to preview.</li>
                <li onClick={() => scrollToScan("price")}><strong>Price.</strong> Every balance is priced in USD, with friendly names from on-chain metadata when available.</li>
                <li onClick={() => scrollToScan("propose")}><strong>Propose.</strong> Each position gets the economical action — swap, burn, or close — with estimated recovery, fees, and rent refund.</li>
                <li onClick={() => scrollToScan("approve")}><strong>You approve.</strong> Check every account, sign a real mainnet transaction batch, and recovered value lands directly in your wallet.</li>
              </ol>
            </div>

            <div className="marketing-block">
              <span className="eyebrow">WHY TIDIFY IS SAFE</span>
              <h2>Your wallet signs. Nothing is forced.</h2>
              <ul className="marketing-safety">
                <li><strong>Non-custodial.</strong> Funds never pass through a Tidify-controlled account; your wallet signs every transaction.</li>
                <li><strong>Nothing is forced.</strong> Every account must be explicitly selected; the default is always to do nothing.</li>
                <li><strong>Fee ceiling on-chain.</strong> The protocol fee is configurable on-chain and capped; the preview shows the maximum before you approve.</li>
                <li><strong>Unverified tokens are labeled.</strong> Tokens without verifiable metadata are marked “Unverified token” and link to an explorer.</li>
                <li><strong>Unsupported tokens are left alone.</strong> Non-transferable or unsupported token accounts are never swapped.</li>
              </ul>
            </div>

            <div className="marketing-block">
              <span className="eyebrow">FEES</span>
              <h2>Small, capped, shown before you approve</h2>
              <p>
                Tidify charges a small protocol fee, set on-chain and capped, on the value it helps you
                recover. You also pay the Solana network fee and, when a swap route is used, the Jupiter
                platform fee. Every position shows its estimated net recovery <em>before</em> you approve
                anything — no surprises at signing time.
              </p>
            </div>
          </section>
        )}

        {stage === "review" && (
          <section className="review-layout enter">
            <div className="review-main">
              <div className="review-title">
                <div>
                  <span className="eyebrow">02 / REVIEW</span>
                  <h1>Your Tidify plan</h1>
                  <p>We found {positions.length} token subaccount{positions.length === 1 ? "" : "s"}. These are the hidden token accounts your wallet creates for individual assets. Nothing happens unless you select them.</p>
                </div>
                <button className="secondary" onClick={restart}>↻ Rescan</button>
              </div>

              <div id="review-threshold">
                <fieldset className="threshold-card">
                  <legend>Your destination currency</legend>
                  <div className="output-dropdown">
                    {outputOpen && <div className="dropdown-backdrop" onClick={() => setOutputOpen(false)} />}
                    <button type="button" className="output-select" onClick={() => setOutputOpen((v) => !v)}>
                      <span className="token-icon-wrap">
                        <img src={outputCurrency.icon} alt="" className="token-icon" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                        <span className="token-icon-fallback">{outputCurrency.label[0]}</span>
                      </span>
                      <span className="output-select-label">{outputCurrency.label}</span>
                      <span className="output-select-sub">{outputCurrency.sub}</span>
                      <span className="output-select-chev">▾</span>
                    </button>
                    {outputOpen && (
                      <div className="output-menu">
                        {OUTPUT_CURRENCY_OPTIONS.map((opt) => (
                          <button type="button" key={opt.mint} className={opt.mint === outputMint ? "output-option chosen" : "output-option"} onClick={() => { setOutputMint(opt.mint); setOutputOpen(false); }}>
                            <span className="token-icon-wrap">
                              <img src={opt.icon} alt="" className="token-icon" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                              <span className="token-icon-fallback">{opt.label[0]}</span>
                            </span>
                            <span className="output-option-label">{opt.label}</span>
                            <small>{opt.sub}</small>
                            {opt.mint === outputMint && <span className="check">✓</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <small className="output-hint">
                    Kept as your destination — never proposed for tidying.
                  </small>
                </fieldset>

                <fieldset className="threshold-card">
                  <legend>Which small balances should Tidify consider?</legend>
                  <label className={thresholdMode === "fixed" ? "radio-option chosen" : "radio-option"}>
                    <input type="radio" checked={thresholdMode === "fixed"} onChange={() => setThresholdMode("fixed")} />
                    <span className="fake-radio" />
                    <span className="option-copy"><strong>Fixed USDC value <b>Suggested</b></strong><small>Each position below this amount</small></span>
                    <span className="input-shell">$<input aria-label="Fixed USDC threshold" type="number" min="0" step="0.5" value={fixedThreshold} onChange={(event) => setFixedThreshold(Math.max(0, Number(event.target.value)))} /></span>
                  </label>
                  <label className={thresholdMode === "percent" ? "radio-option chosen" : "radio-option"}>
                    <input type="radio" checked={thresholdMode === "percent"} onChange={() => setThresholdMode("percent")} />
                    <span className="fake-radio" />
                    <span className="option-copy"><strong>Percentage of portfolio</strong><small>{portfolioPercent}% of {fmtOutput(portfolioOutput)} = {fmtOutput(thresholdOutput)}</small></span>
                    <span className="input-shell"><input aria-label="Portfolio percentage" type="number" min="0" max="10" step="0.1" value={portfolioPercent} onChange={(event) => setPortfolioPercent(Math.max(0, Number(event.target.value)))} />%</span>
                  </label>
                </fieldset>
              </div>

              <div className="recovery-hero">
                <div>
                  <span className="eyebrow">RECOVERABLE</span>
                  <strong className="recovery-value">{fmtRecovery(totals.netUsd)}</strong>
                  <small>{selectedPositions.length} asset{selectedPositions.length === 1 ? "" : "s"} ready to tidy</small>
                </div>
                <dl>
                  <div><dt>Swaps</dt><dd>{fmtRecovery(recoveryBreakdown.swap)}</dd></div>
                  <div><dt>Account rent</dt><dd>{totals.rent.toFixed(6)} SOL<span className="hero-sub">≈ {usd(totals.rent * solPrice)}</span></dd></div>
                  <div><dt>Maximum fee</dt><dd>−{feesSol.toFixed(6)} SOL<span className="hero-sub">≈ {usd(totals.feesUsd)}</span></dd></div>
                  <div className="receive"><dt>You receive</dt><dd>{fmtRecovery(totals.netUsd)}</dd></div>
                </dl>
              </div>

              <div className="time-saved-tracker" aria-live="polite">
                <div className="time-rings" aria-hidden="true"><span /></div>
                <div>
                  <span className="eyebrow">ESTIMATED TIME SAVED</span>
                  <strong>{estimatedTimeSaved(selectedPositions.length)}</strong>
                  <small>Compared with completing each swap or rent reclaim manually · ~1 minute per action</small>
                </div>
              </div>

              <div className="threshold-strip">
                <div><span>Balance threshold</span><strong>{thresholdMode === "fixed" ? `${usd(threshold)} USDC` : fmtOutput(thresholdOutput)}</strong></div>
                <div><span>Token valued portfolio</span><strong>{fmtOutput(portfolioOutput)}</strong></div>
                <div><span>Below threshold</span><strong>{classified.filter((item) => item.valueUsdc !== null && item.valueUsdc <= threshold).length} accounts</strong></div>
                <button
                  onClick={() =>
                    document.querySelector("#review-threshold")?.scrollIntoView({ behavior: "smooth", block: "center" })
                  }
                >
                  Edit definition
                </button>
              </div>

              <div className="selection-tools">
                <span><strong>{selectedPositions.length}</strong> selected</span>
                <div>
                  <button onClick={selectRecommended}>Select recommended</button>
                  <button onClick={() => { setSelected(new Set()); setBurnConfirmed(false); }}>Clear</button>
                </div>
              </div>

              <div className="position-list">
                {classified.length === 0 ? (
                  <div className="empty-state">
                    <strong>No token accounts found</strong>
                    <p>
                      No accounts to tidy were found. Either this wallet has no token
                      accounts on Solana mainnet, every balance is your selected
                      output currency (USDC/USDT/SOL), or wallet data is temporarily unavailable.
                    </p>
                    <button className="secondary" onClick={restart}>↻ Back to setup</button>
                  </div>
                ) : (
                  GROUP_ORDER.map((key) => {
                    const group = groups[key];
                    if (group.length === 0) return null;
                    const meta = GROUP_META[key];
                    const collapsed = collapsedGroups.has(key);
                    const groupRent =
                      group.reduce((s, p) => s + p.rentLamports, 0) / 1e9;
                    const groupValue = group.reduce(
                      (s, p) => s + (p.valueUsdc ?? 0),
                      0,
                    );
                    const selectedInGroup = group.filter((p) =>
                      selected.has(p.id),
                    ).length;
                    return (
                      <section className={`group-section ${key}`} key={key}>
                        <button
                          className="group-header"
                          onClick={() => toggleGroup(key)}
                          aria-expanded={!collapsed}
                        >
                          <span className="group-icon">{meta.icon}</span>
                          <span className="group-title">
                            <strong>{meta.title}</strong>
                            <small>{meta.sub}</small>
                          </span>
                          <span className="group-meta">
                            {key === "recover" && (
                              <strong>+{groupRent.toFixed(3)} SOL</strong>
                            )}
                            {key === "convert" && <strong>≈ {usd(groupValue)}</strong>}
                            {key === "keep" && <strong>≈ {usd(groupValue)}</strong>}
                            {key === "remove" && (
                              <strong>+{groupRent.toFixed(3)} SOL rent</strong>
                            )}
                            {(key === "protected" || key === "unknown") && (
                              <strong>{group.length} asset{group.length === 1 ? "" : "s"}</strong>
                            )}
                            <small>
                              {key === "remove"
                                ? selectedInGroup === 0
                                  ? "nothing selected — review manually"
                                  : `${selectedInGroup}/${group.length} selected`
                                : `${selectedInGroup}/${group.length} selected`}
                            </small>
                          </span>
                          <span className={`chevron ${collapsed ? "" : "expanded"}`}>›</span>
                        </button>
                        {!collapsed && (
                          <div className="group-body">
                            {group.map((position, index) => {
                              const selectable = position.action !== "keep" && position.action !== "unsupported";
                              const isSelected = selected.has(position.id);
                              return (
                                <article className={`position ${isSelected ? "selected" : ""} ${!selectable ? "disabled" : ""}`} style={{ animationDelay: `${Math.min(index, 16) * 45}ms` }} key={position.id}>
                                  <button className="position-top" onClick={() => selectable && togglePosition(position)}>
                                    <span className={`checkbox ${isSelected ? "checked" : ""}`}>{isSelected && "✓"}</span>
                                    <TokenAvatar
                                      logo={position.logo ?? logoOverrides[position.mint]}
                                      symbol={position.symbol}
                                    />
                                    <span className="token-name"><strong>{position.symbol}</strong><small>{position.name} · {position.tokenProgram}</small></span>
                                    <span className="token-balance"><strong>{position.amount}</strong>{position.amountRaw === 0n && <span className="verified-zero">Verified 0</span>}<small>{position.valueUsdc === null ? "Unknown value" : usd(position.valueUsdc)}</small></span>
                                    <span className={`action-badge ${position.action}`}><i />{ACTION_LABEL[position.action]}</span>
                                    <span
                                      className={`chevron ${expanded === position.id ? "expanded" : ""}`}
                                      title={expanded === position.id ? "Hide details" : "Show details"}
                                      aria-label={expanded === position.id ? "Hide details" : "Show details"}
                                      onClick={(event) => { event.stopPropagation(); setExpanded(expanded === position.id ? null : position.id); }}
                                    >›</span>
                                  </button>
                                  {(!selectable && position.actionReason) && (
                                    <div className="position-detail static-reason">
                                      <p>{position.actionReason}</p>
                                    </div>
                                  )}
                                  {expanded === position.id && (
                                    <div className="position-detail">
                                      <p>{position.actionReason}</p>
                                      <div className="economics">
                                        <div><span>Token value</span><strong>{position.valueUsdc === null ? "Unavailable" : usd(position.valueUsdc)}</strong></div>
                                        {position.swapOutputUsdc !== undefined && <div><span>Expected swap output</span><strong>{usd(position.swapOutputUsdc)}</strong></div>}
                                        <div><span>Rent recovered</span><strong>+{(position.rentLamports / 1e9).toFixed(6)} SOL</strong></div>
                                        {position.route && <div className="route-line"><span>Route</span><strong>{position.symbol} <i /> Jupiter <i /> {outputCurrency.label}</strong></div>}
                                        {position.protocolFeeLamports !== undefined && (
                                          <div><span>Maximum protocol fee</span><strong>−{(position.protocolFeeLamports / 1e9).toFixed(6)} SOL</strong></div>
                                        )}
                                        {position.swapFeeUsdc !== undefined && (
                                          <div><span>Swap platform fee</span><strong>−{usd(position.swapFeeUsdc)}</strong></div>
                                        )}
                                        <div className="net"><span>Estimated net recovery</span><strong>{position.netRecoveryLamports > 0 ? `≈ ${fmtRecovery((position.netRecoveryLamports / Number(LAMPORTS_PER_SOL)) * solPrice)}` : "—"}</strong></div>
                                      </div>
                                      <div className="addresses">
                                        <span>Token account {short(position.tokenAccount)}</span>
                                        <span>
                                          Mint{" "}
                                          <a
                                            href={`${EXPLORER_URL}/token/${position.mint}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            title={position.mint}
                                          >
                                            {position.mint}
                                          </a>
                                        </span>
                                      </div>
                                    </div>
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  })
                )}
              </div>
              {selectedPositions.length > 0 && (
                <div className="command-bar">
                  <div><strong>{selectedPositions.length}</strong><span>selected</span></div>
                  <div><strong>{fmtRecovery(totals.netUsd)}</strong><span>estimated recovery</span></div>
                  <div><strong>{estimatedTimeSaved(selectedPositions.length)}</strong><span>estimated time saved</span></div>
                  <button
                    className="primary"
                    disabled={configStatus !== "ok" || !!config?.paused}
                    onClick={() => setStage("confirm")}
                  >
                    Tidy wallet <span>→</span>
                  </button>
                </div>
              )}
            </div>

            <aside className="summary-card">
              <span className="eyebrow">LIVE SUMMARY</span>
              <h2>Your selection</h2>
              <div className="summary-counts">
                <div><span className="mini-icon close">×</span><span>Accounts to recover</span><strong>{selectedPositions.filter((item) => item.action === "close").length}</strong></div>
                <div><span className="mini-icon swap">↗</span><span>Tokens to convert</span><strong>{swapPositions.length}</strong></div>
                <div><span className="mini-icon burn">♨</span><span>Tokens to remove</span><strong>{selectedBurns.length}</strong></div>
              </div>
              <hr />
              <dl>
                <div><dt>Estimated recovery</dt><dd>{fmtRecovery(totals.netUsd)}</dd></div>
                <div><dt>Rent recovered</dt><dd>{totals.rent.toFixed(6)} SOL<span className="usdc-equiv">≈ {usd(totals.rent * solPrice)}</span></dd></div>
                <div><dt>Max protocol fee</dt><dd>{feesSol.toFixed(6)} SOL<span className="usdc-equiv">≈ {usd(totals.feesUsd)}</span></dd></div>
                <div><dt>Transactions</dt><dd>{transactionCount}</dd></div>
              </dl>
              <div className="safety-note"><strong>Nothing is forced.</strong><span>Only the {selectedPositions.length} checked account{selectedPositions.length === 1 ? "" : "s"} will enter real mainnet transactions. Your wallet signs them in one batch approval.</span></div>
              <button className="primary full" disabled={!selectedPositions.length || configStatus !== "ok" || !!config?.paused} onClick={() => setStage("confirm")}>
                {configStatus !== "ok" ? "Transactions temporarily unavailable" : config?.paused ? "Transactions temporarily unavailable" : <>Review selection <span>→</span></>}
              </button>
            </aside>
          </section>
        )}

        {stage === "confirm" && (
          <section className="confirm-wrap enter">
            <button className="back-link" onClick={() => setStage("review")}>← Back to edit selection</button>
            <div className="confirm-card">
              <span className="eyebrow">03 / APPROVE</span>
              <h1>Review exactly what you chose</h1>
              <p>This will build and simulate {transactionCount} real mainnet transaction{transactionCount === 1 ? "" : "s"} against the Tidify protocol, then request one batch approval from your wallet.</p>
              <div className="approval-list">
                {selectedPositions.map((position) => (
                  <div key={position.id}>
                    <TokenAvatar
                      logo={position.logo ?? logoOverrides[position.mint]}
                      symbol={position.symbol}
                    />
                    <span><strong>{position.symbol}</strong><small>{position.amount}{position.amountRaw === 0n ? " · Verified 0" : ""} · {short(position.tokenAccount)}</small></span>
                    <span className={`action-badge ${position.action}`}><i />{ACTION_LABEL[position.action]}</span>
                  </div>
                ))}
              </div>
              {selectedBurns.length > 0 && (
                <label className="burn-confirm">
                  <input type="checkbox" checked={burnConfirmed} onChange={(event) => setBurnConfirmed(event.target.checked)} />
                  <span>
                    <strong>I understand the selected balances will be permanently burned.</strong>
                    <small>{selectedBurns.map((item) => `${item.amount} ${item.symbol}`).join(", ")}</small>
                  </span>
                </label>
              )}
              <div className="approval-totals">
                <div><span>Estimated recovery</span><strong>{fmtRecovery(totals.netUsd)}</strong></div>
                <div><span>Rent recovery</span><strong>{totals.rent.toFixed(6)} SOL</strong></div>
                <div><span>Maximum protocol fee</span><strong>{usd(totals.feesUsd)}</strong></div>
              </div>
              <div className="fixture-callout live-callout">
                <span>!</span>
                <p><strong>Real mainnet execution</strong>Every transaction is simulated first, then all valid transactions are requested in one wallet batch approval and sent separately.</p>
              </div>
              {config?.paused && (
                <div className="fixture-callout live-callout">
                  <span>!</span>
                  <p><strong>Transactions temporarily unavailable</strong>Please try again later.</p>
                </div>
              )}
              <button className="primary full" disabled={(selectedBurns.length > 0 && !burnConfirmed) || !!config?.paused} onClick={execute}>
                {config?.paused ? "Paused — execution disabled" : <>Build, simulate &amp; approve once <span>→</span></>}
              </button>
            </div>
          </section>
        )}

        {stage === "processing" && (
          <section className="process-card enter">
            <div className="orbit"><span>{progress >= progressTotal ? "✓" : "ty"}</span></div>
            <span className="eyebrow">PROCESSING</span>
            <h1>{progress < progressTotal ? "Tidying on mainnet" : "Finished submitting"}</h1>
            <p>{progressLabel || "Working through the transaction plan."} {currentSig && <code>{short(currentSig)}</code>}</p>
            <div className="pipeline">
              {[
                "Revalidated selected accounts",
                "Prepared transactions",
                "Simulated before signing",
                "Wallet signed & sent on mainnet",
              ].map((label, index) => (
                <div className={progress > index ? "done" : progress === index ? "current" : ""} key={label}>
                  <span>{progress > index ? "✓" : index + 1}</span>
                  <strong>{label}</strong>
                  <small>{progress > index ? "Passed" : progress === index ? "Working…" : "Waiting"}</small>
                </div>
              ))}
            </div>
            {fatalError && <div className="error-banner">{fatalError}</div>}
          </section>
        )}

        {stage === "complete" && (
          <section className="complete-card enter">
            <div className={`success-mark ${failedCount > 0 ? "warn" : ""}`}>{failedCount > 0 ? "!" : "✓"}</div>
            <span className="eyebrow">TIDIFY COMPLETE</span>
            <h1>{failedCount > 0 ? "Processed — some transactions failed" : "Your selection was processed"}</h1>
            <p>
              Real mainnet transactions — {confirmedCount} of {results.length} confirmed on-chain
              {failedCount > 0
                ? `, ${failedCount} failed. Check the per-transaction errors below before re-running.`
                : ". Every signature was verified on-chain."}
            </p>
            <div className="result-grid">
              <div><strong>{confirmedPositionCount}</strong><span>accounts processed on-chain</span></div>
              <div><strong>{swapPositions.length}</strong><span>tokens swapped</span></div>
              <div><strong>{selectedBurns.length}</strong><span>tokens burned</span></div>
              <div><strong>{totals.rent.toFixed(6)}</strong><span>SOL rent recovered</span></div>
            </div>
            <div className="event-log">
              {results.map((result, index) => (
                <div className="result-row" key={index}>
                  {result.error ? (
                    <div className={`result-error ${result.errorPhase === "on-chain" ? "onchain" : ""}`}>
                      <div className="result-error-head">
                        <span className="err-mark">✕</span>
                        <strong>{result.label}</strong>
                        <em>{result.errorPhase ? `FAILED · ${result.errorPhase.toUpperCase()}` : "FAILED"}</em>
                      </div>
                      <pre className="err-text">{result.error}</pre>
                      <p className="err-hint">
                        {result.errorPhase === "build"
                          ? "The transaction was never sent — the error happened while constructing it. No funds moved."
                          : result.errorPhase === "simulation"
                            ? "The transaction was never sent — it failed pre-flight simulation. No funds moved."
                            : result.errorPhase === "on-chain"
                              ? "The transaction was sent and included in a block, but the program rejected it. Only the transaction fee was spent."
                              : result.errorPhase === "size"
                                ? "The transaction exceeds Solana's 1232-byte wire limit — this Jupiter route cannot fit in the protocol's swap instruction. No funds moved."
                                : "The transaction could not be sent or confirmed. Check your connection and wallet."}
                        {result.signature && (
                          <a href={`${EXPLORER_URL}/tx/${result.signature}`} target="_blank" rel="noreferrer">View on Orb ↗</a>
                        )}
                      </p>
                    </div>
                  ) : (
                    <p>
                      <span className="pulse" />
                      <strong>{result.label}</strong>
                      <small>{result.positionIds.length} account{result.positionIds.length === 1 ? "" : "s"} · {short(result.signature)}</small>
                      <a href={`${EXPLORER_URL}/tx/${result.signature}`} target="_blank" rel="noreferrer">Orb ↗</a>
                    </p>
                  )}
                </div>
              ))}
            </div>
            <div className="complete-actions">
              <button className="secondary" onClick={() => setStage("review")}>Return to selection</button>
              <button className="primary" onClick={restart}>Scan again <span>→</span></button>
            </div>
          </section>
        )}
      </main>

      <footer>
        <span>Tidify</span>
        <span>Small balances, made useful on Solana.</span>
        <a
          href={`${EXPLORER_URL}/program/${PROGRAM_ID.toBase58()}`}
          target="_blank"
          rel="noreferrer"
          title={PROGRAM_ID.toBase58()}
        >
          Solana program · {short(PROGRAM_ID.toBase58())} ↗
        </a>
      </footer>
    </div>
  );
}

export default App;
