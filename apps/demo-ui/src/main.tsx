import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";
import App from "./App";
import "./styles.css";
import { RPC_URL } from "./lib/constants";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={[new SolflareWalletAdapter({
        appIdentity: {
          name: "Tidify",
          uri: "https://tidify.xyz",
          icon: "https://tidify.xyz/favicon-512.png",
        },
      })]} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </StrictMode>,
);
