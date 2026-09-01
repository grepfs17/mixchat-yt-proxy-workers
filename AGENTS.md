# MixChat YouTube Proxy Workers

Proxies YouTube InnerTube API requests through a Cloudflare Worker so that MixChat's main server IP never talks to YouTube directly.

## What this project does

Same as the Vercel version (`mixchat-yt-proxy`), but running on Cloudflare Workers instead. The proxy validates auth, rate-limits by IP, merges InnerTube session context into requests, and forwards them to YouTube — returning the raw response unchanged.

## Tech stack

- Cloudflare Workers (TypeScript)
- Manual InnerTube context construction (no youtubei.js dependency)
  - **Bundle size**: Cloudflare Workers has a 10MB limit (free and paid). youtubei.js is too large to fit.
  - **Runtime incompatibility**: Workers runs on V8, not Node.js. youtubei.js depends on Node.js APIs (crypto, JSDOM) that don't work without heavy polyfilling.
  - **Simplicity**: The proxy only needs to construct the InnerTube `context` object and forward requests — it doesn't need a full YouTube client library.
- Web standard APIs (Request/Response/fetch)

## Key differences from Vercel version

| Feature | Vercel | Workers |
|---|---|---|
| Runtime | Node.js (Vercel serverless) | Cloudflare Workers (V8) |
| InnerTube session | youtubei.js library | Manual context construction |
| PoToken generation | JSDOM-based auto-generation | Manual only (env vars) |
| Rate limiting | In-memory Map + setInterval | In-memory Map + lazy cleanup |
| Auth comparison | Node.js crypto.timingSafeEqual | XOR-based constant-time compare |
| Max request duration | 300s (Vercel Pro) | 30s free / configurable on paid |
| Env vars | process.env | env parameter / wrangler secrets |
| Bundle size | No limit | 10MB free / 10MB paid (no youtubei.js needed) |

## Key files

- `src/index.ts` — All logic in one file. InnerTube context construction, auth, rate limiting, request forwarding, and 403 retry with cooldown.
- `wrangler.toml` — Worker config, non-secret env vars, and compatibility settings.

## How requests flow

1. MixChat's InnerTube session has a custom `fetch` that intercepts `/youtubei/v1/*` requests
2. Those get forwarded to the proxy at `/api/youtube/youtubei/v1/<endpoint>`
3. The proxy validates the Bearer auth token (constant-time comparison)
4. The proxy checks rate limits (200 req/min per IP, lazy cleanup)
5. The proxy merges the `context` in the request body — the client's `context` is preserved and the proxy's session context is merged on top, keeping client-specific fields
6. The proxy forwards the request to `https://www.youtube.com/youtubei/v1/<endpoint>`
7. The raw response is streamed back to MixChat unchanged

## Security

- **Auth**: All requests (including health check) require a Bearer token. Token comparison uses XOR-based constant-time comparison to prevent timing attacks.
- **CORS**: `Access-Control-Allow-Origin` is set to `CORS_ORIGIN`. If not configured, CORS headers are empty and browser requests are blocked. Server-to-server requests from MixChat work regardless.
- **Rate limiting**: 200 requests per minute per IP (configurable via `RATE_LIMIT_MAX`). Exceeded requests get a 429 with `Retry-After: 60`. In-memory with lazy cleanup on each request.
- **Health check**: Requires auth. Does not leak service info to unauthenticated requests.

## Important constraints

- Cloudflare Workers free plan has a 10ms CPU time limit and 30s wall time limit. Live chat long-polling may require the paid plan with extended timeouts.
- No JSDOM/PoToken auto-generation on Workers. Set `YT_POTOKEN` and `YT_VISITOR_DATA` manually if needed.
- All code is in `src/index.ts` for simplicity.
- Both proxy and MixChat should use the same `YT_CLIENT` (default `WEB`) for compatible response formats.
- Secrets (AUTH_TOKEN, YT_COOKIE, YT_POTOKEN, YT_VISITOR_DATA) must be set via `wrangler secret put`. Non-sensitive vars go in `wrangler.toml` [vars].

## Commands

- `npm run dev` — Start local dev server (wrangler dev)
- `npm run type-check` — TypeScript check
- `npm run deploy` — Deploy to production (wrangler deploy)

## Environment variables

See `.env.example` for full documentation. Key ones:

- `AUTH_TOKEN` — Required. Bearer token for auth. Set via `wrangler secret put AUTH_TOKEN`.
- `CORS_ORIGIN` — Required. Your MixChat URL for CORS. Set via `wrangler secret put CORS_ORIGIN` or in `wrangler.toml` [vars].
- `YT_CLIENT` — Default `WEB`. Client type for InnerTube. Must match MixChat's setting.
- `YT_DEBUG` — Set to `1` for verbose logs.
- `YT_POTOKEN` — Manual PoToken (set via `wrangler secret put YT_POTOKEN`).
- `YT_VISITOR_DATA` — Manual visitor data (set via `wrangler secret put YT_VISITOR_DATA`).

## 403 handling

YouTube 403 responses invalidate the session. The proxy does **not** enter a blanket cooldown or serve `503` to other requests: the 403 is passed through to MixChat, and the next request immediately rebuilds a fresh session (new visitor data, no stale companion data). This mirrors the Vercel proxy, which stays up under the same conditions. MixChat's side has its own cooldown in `src/lib/youtube.ts`.

After the second 403 within 5 minutes, the worker considers the env-provided `YT_VISITOR_DATA`/`YT_POTOKEN` pair blocked and stops reusing it for 30 minutes: sessions get freshly generated visitor data, the user agent rotates, and the `?pot=` param is dropped (a PoToken is bound to its paired visitor data, so sending a stale pot with fresh data can itself trigger bot checks). After the 30-minute window the env pair is tried again — YouTube blocks are often temporary. This stops a flagged pair from keeping the proxy blocked for hours without permanently bricking the worker.

Browser-fingerprint fidelity matters: visitor data must be an 11-char URL-safe base64 id (protobuf-encoded like youtubei.js produces, not a hex string), the WEB client must use a desktop Chrome user agent (no Firefox/macOS mixes), and `CLIENT_VERSION` must stay current — YouTube bot-checks anomalous fingerprints on their own.

## Setting secrets

```bash
wrangler secret put AUTH_TOKEN
wrangler secret put CORS_ORIGIN
wrangler secret put YT_COOKIE
wrangler secret put YT_POTOKEN
wrangler secret put YT_VISITOR_DATA
```