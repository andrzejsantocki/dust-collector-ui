import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  // The Pages repository is served from the tidify.xyz custom-domain root.
  base: "/",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Vendor chunk splitting: cache react separately from the app.
        //
        // IMPORTANT: keep this split acyclic. The Solana stack is heavily
        // interconnected (web3.js <-> anchor <-> wallet-adapter <-> bn.js/buffer/
        // bs58), so finer-grained splits produced circular chunks that broke
        // module init order at runtime (app never mounted). Splitting only
        // react is safe because nothing in react imports Solana — a strict DAG.
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-dom/client", "scheduler"],
        },
      },
    },
  },
});
