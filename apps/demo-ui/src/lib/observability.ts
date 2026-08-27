type EventProps = Record<string, unknown>;

type PostHogClient = {
  init: (key: string, options: Record<string, unknown>) => void;
  capture: (event: string, props?: EventProps) => void;
  identify: (distinctId: string, props?: EventProps) => void;
  reset?: () => void;
};

declare global {
  interface Window {
    posthog?: PostHogClient;
  }
}

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ||
  "https://us.i.posthog.com";

let loaded = false;
let enabled = false;

function loadPostHogScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.posthog) return Promise.resolve();
  if (loaded) {
    return new Promise((resolve) => {
      const check = () => (window.posthog ? resolve() : setTimeout(check, 50));
      check();
    });
  }
  loaded = true;
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = `${POSTHOG_HOST.replace(/\/$/, "")}/static/array.js`;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
}

export async function initObservability() {
  if (!POSTHOG_KEY || typeof window === "undefined") return;
  await loadPostHogScript();
  if (!window.posthog) return;
  window.posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: true,
    capture_pageleave: true,
    request_batching: false,
    session_recording: {
      maskAllInputs: true,
      maskInputOptions: { password: true, email: true },
    },
  });
  enabled = true;
  capture("page_view", {
    path: window.location.pathname,
    search: window.location.search,
  });
}

export function capture(event: string, props: EventProps = {}) {
  if (!enabled || !window.posthog) return;
  window.posthog.capture(event, {
    app: "tidify",
    ...props,
  });
}

export function identifyWallet(wallet: string) {
  if (!enabled || !window.posthog) return;
  window.posthog.identify(wallet, {
    wallet,
    wallet_short: shortWallet(wallet),
  });
  capture("wallet_connected", { wallet, wallet_short: shortWallet(wallet) });
}

export function shortWallet(wallet: string) {
  return wallet.length > 10 ? `${wallet.slice(0, 4)}...${wallet.slice(-4)}` : wallet;
}

export function newScanId() {
  return `scan_${crypto.randomUUID()}`;
}

export function markMs(started: number) {
  return Math.round(performance.now() - started);
}
