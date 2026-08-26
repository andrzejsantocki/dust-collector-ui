# Tidify RPC Worker

Cloudflare Worker RPC proxy for Tidify.

## Why

GitHub Pages is static, so the browser cannot safely hold the Helius API key. This Worker keeps `HELIUS_API_KEY` server-side and logs per-RPC latency/status.

## Setup

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put HELIUS_API_KEY
```

## Local dev

```bash
npm run dev
```

Smoke test:

```bash
curl -X POST http://127.0.0.1:8787 \
  -H "Content-Type: application/json" \
  -H "Origin: https://tidify.xyz" \
  -H "X-Tidify-Scan-Id: scan_local_test" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["11111111111111111111111111111111"]}'
```

## Deploy

```bash
npm run deploy
```

Then in Cloudflare dashboard:

```text
Workers & Pages → tidify-rpc → Settings → Triggers → Custom Domains → api.tidify.xyz
```

## Frontend endpoint

Use:

```ts
const connection = new Connection("https://api.tidify.xyz", "confirmed");
```

## Logs

```bash
npm run tail
```

Log fields:

- `type`
- `request_id`
- `scan_id`
- `ip`
- `methods`
- `duration_ms`
- `status`
- rate-limit headers when Helius returns them
