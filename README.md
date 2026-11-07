# Mixchat YouTube Proxy Workers

A Cloudflare Worker that proxies YouTube InnerTube API requests. Mixchat uses this to route all YouTube API traffic through a separate domain, avoiding IP blocks from YouTube on the main app server.

## How it works

Mixchat sends InnerTube API requests here. The proxy adds its own session context (API key, visitor data, client headers) and forwards the request to YouTube. The raw response is sent back unchanged.

This way Mixchat's server IP never talks to YouTube directly — only Cloudflare's IPs do.

### No youtubei.js

Unlike the Vercel version, this proxy doesn't use the `youtubei.js` library:

- **Bundle size**: Cloudflare Workers has a 10MB limit. youtubei.js is too large to fit.
- **Runtime**: Workers runs on V8, not Node.js. youtubei.js depends on Node.js APIs (crypto, JSDOM) that don't work without heavy polyfilling.
- **Simplicity**: The proxy only needs to construct the InnerTube `context` object and forward requests — it doesn't need a full YouTube client library.

InnerTube API keys are hardcoded because they're public (embedded in YouTube's client-side JavaScript) and only identify the client type, not a user or project. This is the same approach used by youtubei.js, yt-dlp, and Invidious.

## Endpoints

**`GET /api/youtube`** — Health check, returns `{ status: "ok" }`

**`POST /api/youtube/youtubei/v1/<endpoint>`** — Proxies the request to YouTube

All requests (including health check) require an `Authorization: Bearer <token>` header matching the `AUTH_TOKEN` secret.

Example:
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"videoId":"dQw4w9WgXcQ","context":{...}}' \
  "https://your-proxy.workers.dev/api/youtube/youtubei/v1/player?prettyPrint=false"
```

The `context` in the body is merged with the proxy's session context (preserving client-specific fields), so the client's `context.client.clientName` and similar fields are kept.

## Setup

1. Install dependencies: `npm install`
2. Set secrets: `wrangler secret put AUTH_TOKEN` (and others, see below)
3. Configure non-secret vars in `wrangler.toml` `[vars]` or via secrets
4. Deploy: `npm run deploy`
5. In Mixchat, set `YT_PROXY` to your Worker URL and `YT_PROXY_TOKEN` to the auth token

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTH_TOKEN` | Yes | — | Shared secret for Bearer auth. XOR-based constant-time comparison prevents timing attacks. |
| `CORS_ORIGIN` | Yes | — | Allowed origin for CORS. Set to your Mixchat URL. If empty, browser requests are blocked. |
| `YT_CLIENT` | No | `WEB` | InnerTube client type. Must match Mixchat's `YT_CLIENT` for compatible response formats. |
| `YT_DEBUG` | No | `0` | Set to `1` for verbose logging |
| `YT_USER_AGENT` | No | Chrome 124 | Custom User-Agent string |
| `YT_COOKIE` | No | — | Browser cookie string for authenticated access |
| `YT_POTOKEN` | No | — | Manual PoToken override |
| `YT_VISITOR_DATA` | No | — | Manual visitor data override |
| `RATE_LIMIT_MAX` | No | `200` | Max requests per minute per IP |

Secrets (`AUTH_TOKEN`, `CORS_ORIGIN`, `YT_COOKIE`, `YT_POTOKEN`, `YT_VISITOR_DATA`) must be set via `wrangler secret put`.

## Local development

```bash
npm install
cp .env.example .env
# Edit .env with your AUTH_TOKEN
npm run dev
```

## Architecture

- `src/index.ts` — All logic in one file. InnerTube context construction, auth, rate limiting, request forwarding, and 403 retry with cooldown.
- `wrangler.toml` — Worker config, non-secret env vars, and compatibility settings.

## 403 handling

When YouTube returns a 403, the proxy invalidates its session (regenerates visitor data) and passes the 403 straight back to Mixchat — there is no blanket cooldown that blocks all other requests, so a single flagged request never takes the whole proxy down. The next request rebuilds a fresh session immediately. After repeated 403s the env-provided visitor/PoToken pair is retired for 30 minutes and fresh visitor data is used without a PoToken, then the env pair is retried.

Mixchat's side also has its own cooldown.

## Security

- **Auth**: All requests require a Bearer token. If `AUTH_TOKEN` is not configured the proxy refuses every request with `503` instead of running open. Token comparison uses XOR-based constant-time comparison to prevent timing attacks.
- **CORS**: `Access-Control-Allow-Origin` is set to `CORS_ORIGIN`. If not configured, CORS headers are empty and browser requests are blocked. Server-to-server requests (from Mixchat) work regardless since they don't enforce CORS.
- **Rate limiting**: 200 requests per minute per IP (configurable via `RATE_LIMIT_MAX`). Exceeded requests get a 429 with a `Retry-After: 60` header.
- **Health check**: Requires auth. Does not leak service info to unauthenticated requests.

## Important constraints

- Cloudflare Workers free plan has a 10ms CPU time limit and 30s wall time limit. Live chat long-polling may require the paid plan with extended timeouts.
- No JSDOM/PoToken auto-generation on Workers. Set `YT_POTOKEN` and `YT_VISITOR_DATA` manually if needed.
- Both this proxy and Mixchat should use the same `YT_CLIENT` (default `WEB`) for compatible response formats.
