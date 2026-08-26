# Tidify Cloudflare Worker RPC setup

Goal: keep `tidify.xyz` on GitHub Pages, move Solana RPC calls through a tiny Cloudflare Worker at `api.tidify.xyz` so the Helius key stays server-side and RPC latency/errors are observable.

## Architecture

```text
Browser / GitHub Pages
  https://tidify.xyz
        |
        | POST JSON-RPC
        v
Cloudflare Worker
  https://api.tidify.xyz
        |
        | server-side Helius key
        v
Helius RPC
  https://mainnet.helius-rpc.com/?api-key=...
```

## 1. Create Worker

```bash
npm create cloudflare@latest tidify-rpc
cd tidify-rpc
npm install
```

Suggested choices:

```text
Worker only
TypeScript: yes
Deploy immediately: no
```

## 2. Login

```bash
npx wrangler login
```

Approve in browser.

## 3. Configure `wrangler.toml`

```toml
name = "tidify-rpc"
main = "src/index.ts"
compatibility_date = "2026-08-26"
```

## 4. Replace `src/index.ts`

```ts
const ALLOWED_ORIGINS = new Set([
  "https://tidify.xyz",
  "https://www.tidify.xyz",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getTokenAccountsByOwner",
  "getBalance",
  "getMultipleAccounts",
  "getLatestBlockhash",
  "getRecentBlockhash",
  "getMinimumBalanceForRentExemption",
  "simulateTransaction",
  "getTransaction",
  "getSignaturesForAddress",
  "getProgramAccounts",
]);

export interface Env {
  HELIUS_API_KEY: string;
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://tidify.xyz";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Tidify-Scan-Id",
    "Access-Control-Expose-Headers": "Server-Timing, X-Tidify-Request-Id",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

function json(data: unknown, status: number, headers: HeadersInit) {
  return new Response(JSON.stringify(data), { status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, headers);
    }

    const requestId = crypto.randomUUID();
    const scanId = request.headers.get("X-Tidify-Scan-Id") ?? null;

    let bodyText = "";
    let rpc: any;

    try {
      bodyText = await request.text();
      rpc = JSON.parse(bodyText);
    } catch {
      return json({ error: "Invalid JSON" }, 400, {
        ...headers,
        "X-Tidify-Request-Id": requestId,
      });
    }

    const calls = Array.isArray(rpc) ? rpc : [rpc];

    for (const call of calls) {
      if (!call || typeof call.method !== "string") {
        return json({ error: "Invalid RPC request" }, 400, headers);
      }

      if (!ALLOWED_METHODS.has(call.method)) {
        console.log(JSON.stringify({
          type: "rpc_blocked",
          request_id: requestId,
          scan_id: scanId,
          method: call.method,
          timestamp: new Date().toISOString(),
        }));

        return json({ error: "RPC method not allowed" }, 403, {
          ...headers,
          "X-Tidify-Request-Id": requestId,
        });
      }
    }

    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyText,
          signal: controller.signal,
        }
      );

      const result = await response.text();
      const duration = performance.now() - started;

      console.log(JSON.stringify({
        type: "helius_rpc",
        request_id: requestId,
        scan_id: scanId,
        methods: calls.map((c) => c.method),
        duration_ms: Math.round(duration),
        status: response.status,
        ratelimit_limit: response.headers.get("x-ratelimit-limit"),
        ratelimit_remaining: response.headers.get("x-ratelimit-remaining"),
        ratelimit_reset: response.headers.get("x-ratelimit-reset"),
        timestamp: new Date().toISOString(),
      }));

      return new Response(result, {
        status: response.status,
        headers: {
          ...headers,
          "Server-Timing": `helius;dur=${duration.toFixed(1)}`,
          "X-Tidify-Request-Id": requestId,
        },
      });
    } catch (error) {
      const duration = performance.now() - started;

      console.log(JSON.stringify({
        type: "helius_rpc_error",
        request_id: requestId,
        scan_id: scanId,
        methods: calls.map((c) => c.method),
        duration_ms: Math.round(duration),
        error: String(error),
        timestamp: new Date().toISOString(),
      }));

      return json({ error: "RPC timeout or failure" }, 504, {
        ...headers,
        "Server-Timing": `helius;dur=${duration.toFixed(1)}`,
        "X-Tidify-Request-Id": requestId,
      });
    } finally {
      clearTimeout(timeout);
    }
  },
};
```

## 5. Store Helius key as secret

Never commit the Helius API key.

```bash
npx wrangler secret put HELIUS_API_KEY
```

Paste key when prompted.

## 6. Test locally

```bash
npx wrangler dev
```

In another terminal:

```bash
curl -X POST http://127.0.0.1:8787 \
  -H "Content-Type: application/json" \
  -H "Origin: https://tidify.xyz" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["11111111111111111111111111111111"]}'
```

Expected: JSON-RPC response from Helius.

## 7. Deploy

```bash
npx wrangler deploy
```

Temporary URL will look like:

```text
https://tidify-rpc.<your-subdomain>.workers.dev
```

## 8. Add custom domain

Cloudflare Dashboard:

```text
Workers & Pages
→ tidify-rpc
→ Settings
→ Triggers
→ Custom Domains
→ Add Custom Domain
→ api.tidify.xyz
```

Cloudflare must manage DNS for `tidify.xyz`. If not active yet:

1. Add `tidify.xyz` to Cloudflare.
2. Change nameservers at registrar.
3. Keep GitHub Pages records for the website.
4. Add Worker custom domain after Cloudflare is active.

## 9. Update frontend RPC endpoint

Replace direct Helius URL with Worker URL:

```ts
const RPC_ENDPOINT = "https://api.tidify.xyz";
```

For Solana web3.js:

```ts
const connection = new Connection("https://api.tidify.xyz", "confirmed");
```

## 10. Add request IDs from browser

Generate once per scan:

```ts
const scanId = `scan_${crypto.randomUUID()}`;
```

Send it to Worker:

```ts
fetch("https://api.tidify.xyz", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Tidify-Scan-Id": scanId,
  },
  body: JSON.stringify(rpcBody),
});
```

Worker logs then correlate all RPC calls for one scan.

## 11. View logs

```bash
npx wrangler tail tidify-rpc
```

Example log:

```json
{
  "type": "helius_rpc",
  "request_id": "...",
  "scan_id": "scan_...",
  "methods": ["getTokenAccountsByOwner"],
  "duration_ms": 143,
  "status": 200,
  "timestamp": "2026-08-26T18:03:12.000Z"
}
```

## 12. Rotate Helius key

If any old Helius key was exposed in frontend JS/network traffic:

1. Create new Helius key.
2. Update Worker secret:

```bash
npx wrangler secret put HELIUS_API_KEY
npx wrangler deploy
```

3. Disable old Helius key.

## Later improvements

- Add Cloudflare rate limiting.
- Add stricter RPC method/params allowlist.
- Add per-IP soft caps.
- Add PostHog frontend events.
- Add scan stage timings: RPC, pricing, frontend calc, total.
- Add privacy masking: do not send full balances/RPC payloads to analytics.
