import { PublicKey } from "@solana/web3.js";

// ---- protocol identities (mirror crates/dust-planner/src/transaction.rs) ----
export const PROGRAM_ID = new PublicKey(
  "H5ix9UP5hx3k5W3nu1rMdbDgo5Ahb9Q8RANLdoiXYCgw"
);
export const CONFIG_SEED = Buffer.from("config");
export const VAULT_SEED = Buffer.from("vault");
export const STATS_SEED = Buffer.from("stats");

export const configPda = () =>
  PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID)[0];
export const vaultPda = () =>
  PublicKey.findProgramAddressSync([VAULT_SEED], PROGRAM_ID)[0];
export const statsPda = () =>
  PublicKey.findProgramAddressSync([STATS_SEED], PROGRAM_ID)[0];

// ---- tokens / programs ----
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
export const USDT_MINT = new PublicKey(
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
);
export const SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
export const JUPITER_PROGRAM = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
export const SYSTEM_PROGRAM_ID = new PublicKey(
  "11111111111111111111111111111111"
);

// ---- network ----
const rpcOverride = import.meta.env.VITE_RPC_URL as string | undefined;
export const RPC_URL = rpcOverride || "https://api.tidify.xyz";

// ---- Jupiter endpoints (mirror crates/dust-planner/src/jupiter.rs) ----
export const JUPITER_BUILD_URL = "https://api.jup.ag/swap/v2/build";
export const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
// token.jup.ag/strict was deprecated (Aug 2024). The Tokens API V2 "verified"
// tag is the current curated list and includes icon URLs.
export const JUPITER_TOKEN_LIST_URL =
  "https://api.jup.ag/tokens/v2/tag?query=verified";

// ---- economics defaults (mirror main.rs FeeCfg + scan loop) ----
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const MAX_TX_SIZE = 1232;
export const NETWORK_FEE_LAMPORTS = 5_000n;
export const PRIORITY_FEE_LAMPORTS = 10_000n;
export const USER_MAX_FEE_LAMPORTS = 1_000_000n;
export const SLIPPAGE_BPS = 100;
/** Try progressively SMALLER routes first — big multi-hop routes (Aquifer etc.)
 * carry too many accounts to fit the 1232-byte CPI transaction. */
export const SWAP_MAX_ACCOUNTS_TRIES = [12, 16, 20, 32, 48];
/** Close/burn ops per transaction (CU budget mirror: ~15-20k CU per op, 200k cap). */
export const BATCH_SIZE = 8;
// Orb (Helius) is the app's explorer: /tx/<sig>, /token/<mint>, /program/<id>.
export const EXPLORER_URL = "https://orb.helius.dev";
