import { PublicKey } from "@solana/web3.js";

// On-chain token metadata resolution for mints missing from the Jupiter
// token list. Claim/LP/airdrop tokens (e.g. Kamino vault claim tokens) are
// exactly the dust this app collects — a readable name is a safety feature:
// it stops users swapping something they cannot identify.
//
// Sources, in order of preference (App merges: Jupiter list > on-chain > raw mint):
//   - SPL tokens:      Metaplex metadata PDA (account data, no external API)
//   - Token-2022:      TokenMetadata extension inline, or MetadataPointer
//                      target account (second getAccountInfo hop)
//
// Layouts verified against mainnet accounts (USDC/BONK/JitoSOL Metaplex,
// PYUSD Token-2022). Token-2022 ExtensionType ids are from the current
// spl-token-2022 source (MetadataPointer=18, TokenMetadata=19).

export type TokenMeta = { symbol: string; name: string; uri?: string };

/** Fetches one account; owner is the base58 program id, data the raw bytes. */
export type TokenMetaFetcher = (
  address: string
) => Promise<{ owner: string; data: Uint8Array } | null>;

// Mirror constants.ts — kept local so this module stays framework-free and
// unit-testable (no import.meta.env).
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const METAPLEX_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
const METADATA_SEED = Buffer.from("metadata");

// spl-token-2022 ExtensionType ids (current enum).
const EXT_METADATA_POINTER = 18;
const EXT_TOKEN_METADATA = 19;

const MAX_SYMBOL = 12;
const MAX_NAME = 48;

const decoder = new TextDecoder("utf-8", { fatal: false });

function clean(s: string, max: number): string {
  const out = s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return out.length > max ? out.slice(0, max) : out;
}

function isPrintable(s: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
}

/** u32-length-prefixed string (borsh style). */
function readLenString(
  data: Uint8Array,
  offset: number,
  maxLen: number
): { value: string; next: number; nextPadded: number } | null {
  if (offset + 4 > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint32(offset, true);
  if (len === 0 || len > maxLen) return null;
  const start = offset + 4;
  const end = start + len;
  if (end > data.length) return null;
  const value = decoder.decode(data.subarray(start, end)).replace(/\u0000+$/, "");
  if (!isPrintable(value)) return null;
  const next = end;
  const nextPadded = end + ((4 - (end % 4)) % 4);
  return { value, next, nextPadded };
}

/** Try to parse name/symbol/uri chains starting at the given offset. */
function parseStringsAt(
  data: Uint8Array,
  off: number
): { name: string; symbol: string; uri: string } | null {
  const name = readLenString(data, off, 64);
  if (!name) return null;
  const candidates = [
    [name.next, name.nextPadded],
    [name.nextPadded, name.next],
  ];
  for (const [symOff1, symOff2] of candidates) {
    const symbol = readLenString(data, symOff1, 16);
    if (!symbol) continue;
    for (const uriOff of [symbol.next, symbol.nextPadded]) {
      const uri = readLenString(data, uriOff, 256);
      if (!uri) continue;
      return { name: name.value, symbol: symbol.value, uri: uri.value };
    }
  }
  return null;
}

function sanitizeMeta(
  nameRaw: string,
  symbolRaw: string
): { symbol: string; name: string } | null {
  const name = clean(nameRaw, MAX_NAME);
  const symbol = clean(symbolRaw, MAX_SYMBOL);
  if (!name && !symbol) return null;
  return {
    symbol: symbol || name.slice(0, Math.min(6, name.length)),
    name: name || symbol,
  };
}

/**
 * Token-2022 metadata payload (inline extension data, or the account a
 * MetadataPointer points at). The prefix before the strings is
 * update_authority + mint — 64 or 68 bytes depending on program version —
 * so we scan a small window for a valid name→symbol→uri chain.
 */
export function parseTokenMetadataPayload(data: Uint8Array): TokenMeta | null {
  for (let off = 56; off <= 76; off++) {
    const p = parseStringsAt(data, off);
    if (!p) continue;
    const meta = sanitizeMeta(p.name, p.symbol);
    if (meta) return { ...meta, uri: p.uri };
  }
  return null;
}

/**
 * Token-2022 mint account: 82-byte base header, then a TLV list of
 * extensions (u16 type, u16 length; zero-length Uninitialized entries are
 * padding and are skipped). Returns inline metadata when present and/or a
 * MetadataPointer target that needs a second fetch.
 */
export function parseToken2022Mint(
  data: Uint8Array
): { meta?: TokenMeta; pointer?: string } | null {
  let pos = 82;
  let pointer: string | null = null;
  let meta: TokenMeta | null = null;
  while (pos + 4 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const type = view.getUint16(pos, true);
    const len = view.getUint16(pos + 2, true);
    const body = pos + 4;
    if (body + len > data.length) break;
    if (type === 0) {
      // Uninitialized padding entry — skip.
      pos = body;
      continue;
    }
    if (type === EXT_TOKEN_METADATA && !meta) {
      meta = parseTokenMetadataPayload(data.subarray(body, body + len));
    } else if (type === EXT_METADATA_POINTER && !pointer && len >= 64) {
      // authority (32) + metadata_address (32)
      pointer = new PublicKey(data.subarray(body + 32, body + 64)).toBase58();
    }
    pos = body + len;
  }
  if (!meta && !pointer) return null;
  return { meta: meta ?? undefined, pointer: pointer ?? undefined };
}

/**
 * Metaplex MetadataV1 account: key(1) + update_authority(32) + mint(32) =>
 * name starts at offset 65. Strings are stored as u32 length = field
 * CAPACITY (32 for name, 10 for symbol, 200 for uri) with the content
 * zero-padded to that capacity; older accounts may store the real length.
 * We try both interpretations.
 */
export function parseMetaplexMetadata(data: Uint8Array): TokenMeta | null {
  if (data.length < 69) return null;
  const name = readLenString(data, 65, 64);
  if (!name) return null;
  for (const next of [name.next, name.nextPadded]) {
    const symbol = readLenString(data, next, 16);
    if (!symbol) continue;
    for (const uriOff of [symbol.next, symbol.nextPadded]) {
      const uri = readLenString(data, uriOff, 256);
      if (!uri) continue;
      const meta = sanitizeMeta(name.value, symbol.value);
      if (meta) return { ...meta, uri: uri.value };
    }
  }
  return null;
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

/**
 * Resolve friendly names for mints directly from chain state: Metaplex
 * metadata for SPL tokens, the TokenMetadata extension / MetadataPointer for
 * Token-2022. No external API, no CORS — just getAccountInfo on the existing
 * RPC connection.
 */
export async function fetchOnChainTokenMeta(
  fetcher: TokenMetaFetcher,
  mints: string[]
): Promise<Map<string, TokenMeta>> {
  const result = new Map<string, TokenMeta>();
  if (!mints.length) return result;

  const unique = [...new Set(mints)];
  const mintInfos = await mapConcurrent(unique, 6, async (mint) => ({
    mint,
    info: await fetcher(mint),
  }));

  const pointerTargets = new Map<string, string>(); // metadata account -> mint
  for (const { mint, info } of mintInfos) {
    if (!info) continue;
    if (info.owner === TOKEN_2022_PROGRAM_ID) {
      const parsed = parseToken2022Mint(info.data);
      if (parsed?.meta) result.set(mint, parsed.meta);
      if (parsed?.pointer) pointerTargets.set(parsed.pointer, mint);
    } else if (info.owner === TOKEN_PROGRAM_ID) {
      const [pda] = PublicKey.findProgramAddressSync(
        [
          METADATA_SEED,
          METAPLEX_METADATA_PROGRAM_ID.toBuffer(),
          new PublicKey(mint).toBuffer(),
        ],
        METAPLEX_METADATA_PROGRAM_ID
      );
      const metaInfo = await fetcher(pda.toBase58());
      const meta = metaInfo ? parseMetaplexMetadata(metaInfo.data) : null;
      if (meta) result.set(mint, meta);
    }
  }

  if (pointerTargets.size) {
    const infos = await mapConcurrent(
      [...pointerTargets.keys()],
      6,
      async (addr) => ({ addr, info: await fetcher(addr) })
    );
    for (const { addr, info } of infos) {
      const mint = pointerTargets.get(addr);
      if (!mint || result.has(mint) || !info) continue;
      const meta = parseTokenMetadataPayload(info.data);
      if (meta) result.set(mint, meta);
    }
  }

  return result;
}

/** Identifiable short form of a mint address: AbCd…WxYz. */
export function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

// ---------------------------------------------------------------------------
// Icons from on-chain metadata URIs (best-effort, cached, never blocks).
// ---------------------------------------------------------------------------

const iconCache = new Map<string, Promise<string | null>>();

/**
 * Fetch the token's off-chain metadata JSON and return its image URL.
 * Arweave/IPFS JSON hosts generally allow CORS; anything else fails fast
 * and the caller falls back to the letter avatar.
 */
export function fetchMetadataIcon(
  uri: string,
  timeoutMs = 4000
): Promise<string | null> {
  if (!uri) return Promise.resolve(null);
  if (!iconCache.has(uri)) {
    iconCache.set(
      uri,
      (async () => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          const res = await fetch(uri, { signal: ctrl.signal });
          clearTimeout(timer);
          if (!res.ok) return null;
          const data = (await res.json()) as { image?: unknown };
          return typeof data.image === "string" && data.image
            ? data.image
            : null;
        } catch {
          return null;
        }
      })()
    );
  }
  return iconCache.get(uri)!;
}

/** Resolve icons for mints that have an on-chain metadata uri. */
export async function resolveMetadataIcons(
  entries: { mint: string; uri: string }[],
  concurrency = 4
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let idx = 0;
  async function worker() {
    while (idx < entries.length) {
      const e = entries[idx++];
      const logo = await fetchMetadataIcon(e.uri);
      if (logo) out.set(e.mint, logo);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, entries.length) },
      worker
    )
  );
  return out;
}
