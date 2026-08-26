// Node-global polyfills required by @coral-xyz/anchor / @solana/web3.js in the browser.
// Must be imported FIRST in main.tsx (import order = evaluation order).
import { Buffer } from "buffer";

globalThis.Buffer = Buffer;
