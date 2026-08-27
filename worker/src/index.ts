const ALLOWED_ORIGINS = new Set([
  "https://tidify.xyz",
  "https://www.tidify.xyz",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://127.0.0.1:4175",
  "http://localhost:4175",
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
  "sendTransaction",
  "getTransaction",
  "getSignaturesForAddress",
  "getProgramAccounts",
]);

export interface Env {
  HELIUS_API_KEY: string;
}

type RpcCall = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
};

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://tidify.xyz";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Tidify-Scan-Id, Solana-Client, X-Solana-Client, Accept",
    "Access-Control-Expose-Headers": "Server-Timing, X-Tidify-Request-Id",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

function json(data: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
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

    if (!env.HELIUS_API_KEY) {
      return json({ error: "RPC backend not configured" }, 500, headers);
    }

    const requestId = crypto.randomUUID();
    const scanId = request.headers.get("X-Tidify-Scan-Id") ?? null;

    let bodyText = "";
    let rpc: RpcCall | RpcCall[];

    try {
      bodyText = await request.text();
      rpc = JSON.parse(bodyText) as RpcCall | RpcCall[];
    } catch {
      return json({ error: "Invalid JSON" }, 400, {
        ...headers,
        "X-Tidify-Request-Id": requestId,
      });
    }

    const calls = Array.isArray(rpc) ? rpc : [rpc];

    if (calls.length === 0 || calls.length > 25) {
      return json({ error: "Invalid RPC batch size" }, 400, {
        ...headers,
        "X-Tidify-Request-Id": requestId,
      });
    }

    for (const call of calls) {
      if (!call || typeof call.method !== "string") {
        return json({ error: "Invalid RPC request" }, 400, {
          ...headers,
          "X-Tidify-Request-Id": requestId,
        });
      }

      if (!ALLOWED_METHODS.has(call.method)) {
        console.log(JSON.stringify({
          type: "rpc_blocked",
          request_id: requestId,
          scan_id: scanId,
          ip: clientIp(request),
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
    const methods = calls.map((call) => call.method);
    const hardTimeoutMs = methods.includes("getTokenAccountsByOwner") || methods.includes("getMultipleAccounts")
      ? 15000
      : 5000;
    const timeout = setTimeout(() => controller.abort(), hardTimeoutMs);

    try {
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyText,
          signal: controller.signal,
        },
      );

      const result = await response.text();
      const duration = performance.now() - started;

      console.log(JSON.stringify({
        type: "helius_rpc",
        request_id: requestId,
        scan_id: scanId,
        ip: clientIp(request),
        methods: calls.map((call) => call.method),
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
        ip: clientIp(request),
        methods: calls.map((call) => call.method),
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
