// MixChat YouTube Proxy — Cloudflare Workers Edition
// Proxies YouTube InnerTube API requests so MixChat's server IP never talks to YouTube directly.

// ── Types ──────────────────────────────────────────────────────────────
interface Env {
  AUTH_TOKEN?: string;
  CORS_ORIGIN?: string;
  YT_CLIENT?: string;
  YT_DEBUG?: string;
  YT_USER_AGENT?: string;
  YT_COOKIE?: string;
  YT_POTOKEN?: string;
  YT_VISITOR_DATA?: string;
  ORIGIN?: string;
  RATE_LIMIT_MAX?: string;
}

interface ClientConfig {
  clientName: string;
  clientVersion: string;
  apiKey: string;
  userAgent: string;
}

interface SessionState {
  visitorData: string;
  apiKey: string;
  context: Record<string, any>;
  userAgent: string;
  clientConfig: ClientConfig;
  /** Whether this session reuses the env-provided visitor data (paired with YT_POTOKEN). */
  usesEnvVisitor: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000;
const COOLDOWN_AFTER_403_MS = 30_000;

// Rotated per session init so a freshly generated visitor data isn't paired
// with the same fingerprint that just got blocked.
// Chrome desktop only — Firefox/macOS mixes under a WEB client look
// inconsistent and are a known trigger for YouTube bot checks.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
let userAgentCursor = 0;

const DEFAULT_USER_AGENT = USER_AGENTS[0];

// InnerTube API keys are public — they're embedded in YouTube's client-side JS
// and identify the client type (WEB, TV, etc.), not a user or project.
// Same keys used by youtubei.js, yt-dlp, Invidious, etc.
// Client versions must be current — a year-stale clientVersion is itself a
// bot-check trigger. WEB matches the youtubei.js 17.x version MixChat sends.
const CLIENTS: Record<string, ClientConfig> = {
  WEB: {
    clientName: "WEB",
    clientVersion: "2.20260623.01.00",
    apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
    userAgent: DEFAULT_USER_AGENT,
  },
  TVHTML5: {
    clientName: "TVHTML5",
    clientVersion: "7.20250512.10.00",
    apiKey: "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
    userAgent: DEFAULT_USER_AGENT,
  },
  TVHTML5_SIMPLY_EMBEDDED_PLAYER: {
    clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
    clientVersion: "2.0",
    apiKey: "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
    userAgent: DEFAULT_USER_AGENT,
  },
};

// ── Rate limiting (in-memory, per-IP, lazy cleanup) ───────────────────
const ipRequests = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string, maxRequests: number): boolean {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of ipRequests) {
    if (now > entry.resetAt) {
      ipRequests.delete(key);
      cleaned++;
      if (cleaned > 50) break;
    }
  }

  const entry = ipRequests.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRequests.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > maxRequests;
}

// ── Constant-time auth comparison ───────────────────────────────────────
function verifyToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
}

// ── Visitor data generation (protobuf-encoded) ─────────────────────────
function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return bytes;
}

// Real YouTube visitor ids are 11 chars from the URL-safe base64 alphabet
// (same as youtubei.js generateRandomString). A 32-char hex id, as used
// before, is visibly anomalous and can be flagged on its own.
const VISITOR_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function generateVisitorId(): string {
  const bytes = new Uint8Array(11);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < bytes.length; i++) {
    id += VISITOR_ID_ALPHABET[bytes[i] % VISITOR_ID_ALPHABET.length];
  }
  return id;
}

function generateVisitorData(): string {
  const id = generateVisitorId();

  const idUtf8 = new TextEncoder().encode(id);
  const timestamp = Math.floor(Date.now() / 1000);
  const varint = encodeVarint(timestamp);

  const parts: number[] = [];
  parts.push(0x0a, idUtf8.length, ...idUtf8);
  parts.push(0x28, ...varint);

  const buf = new Uint8Array(parts);
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Session management ─────────────────────────────────────────────────
let sessionState: SessionState | null = null;
let isInitializing = false;
let last403Time = 0;

// ── Block detection ────────────────────────────────────────────────────
// YouTube can flag a (visitor data, PoToken) pair as a bot. Reusing the
// flagged pair after a 403 just re-triggers the block, which is why blocks
// used to persist for hours. After repeated 403s we switch to freshly
// generated visitor data and drop the (now stale, unpaired) PoToken so the
// next session looks like a brand-new visitor.
//
// Unlike the previous version, this is NOT permanent: the flag expires after
// SESSION_BLOCK_RESET_MS so the env-provided pair is retried later (YouTube
// blocks are often temporary), and there is no blanket cooldown after a 403 —
// the next request simply rebuilds a fresh session immediately, matching the
// Vercel proxy that keeps working.
let blockedSessionUntil = 0;
let recent403Count = 0;
let last403Timestamp = 0;
const SESSION_BLOCK_403_THRESHOLD = 2;
const SESSION_BLOCK_WINDOW_MS = 5 * 60_000;
const SESSION_BLOCK_RESET_MS = 30 * 60_000;

function invalidateSession(): void {
  sessionState = null;
}

function getClientConfig(clientType: string, env: Env): ClientConfig {
  let ct = (clientType || "WEB").toUpperCase();
  if (ct === "TV") ct = "TVHTML5";
  if (ct === "TVHTML5_TV") ct = "TVHTML5_SIMPLY_EMBEDDED_PLAYER";
  const config = CLIENTS[ct] || CLIENTS["WEB"];
  const userAgent =
    env.YT_USER_AGENT || USER_AGENTS[userAgentCursor++ % USER_AGENTS.length];
  return { ...config, userAgent };
}

function initSession(env: Env): SessionState {
  const clientConfig = getClientConfig(env.YT_CLIENT || "WEB", env);
  // Once YouTube has flagged the env-provided credentials, reuse only makes
  // the block worse — fall back to freshly generated visitor data until the
  // block window expires, then give the env pair another chance.
  const blocked = Date.now() < blockedSessionUntil;
  const usesEnvVisitor = !blocked && !!env.YT_VISITOR_DATA;
  const visitorData =
    !blocked && env.YT_VISITOR_DATA
      ? env.YT_VISITOR_DATA
      : generateVisitorData();
  const debug = env.YT_DEBUG === "1";

  const context = {
    client: {
      hl: "en",
      gl: "US",
      clientName: clientConfig.clientName,
      clientVersion: clientConfig.clientVersion,
      visitorData,
    },
    request: {
      internalExperimentFlags: [],
    },
    user: {},
  };

  if (debug) {
    console.log(`[YouTube] Session initialized (${clientConfig.clientName})`, {
      hasPoToken: !!env.YT_POTOKEN,
      hasCookie: !!env.YT_COOKIE,
      hasVisitorData: !!visitorData,
    });
  }

  return { visitorData, apiKey: clientConfig.apiKey, context, userAgent: clientConfig.userAgent, clientConfig, usesEnvVisitor };
}

function getSession(env: Env): SessionState {
  if (sessionState) return sessionState;

  const now = Date.now();
  const timeSince403 = now - last403Time;
  if (timeSince403 < COOLDOWN_AFTER_403_MS) {
    throw new Error(
      `[YouTube] Cooldown after 403 — retry in ${Math.ceil((COOLDOWN_AFTER_403_MS - timeSince403) / 1000)}s`
    );
  }
  if (isInitializing) {
    throw new Error("[YouTube] Init already in progress");
  }

  isInitializing = true;
  try {
    sessionState = initSession(env);
    return sessionState;
  } catch (error) {
    sessionState = null;
    throw error;
  } finally {
    isInitializing = false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────
function jsonResponse(body: Record<string, any>, status: number, extraHeaders: Record<string, string> = {}): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  return new Response(JSON.stringify(body), { status, headers });
}

function getOrigin(request: Request): string {
  const origin = request.headers.get("origin") || "";
  if (origin) return origin;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {}
  }
  return "";
}

function isAllowedOrigin(origin: string, env: Env): boolean {
  if (!origin) return true;
  const allowed = env.CORS_ORIGIN || "";
  const extra = env.ORIGIN || "";
  return origin === allowed || origin === extra;
}

function corsHeaders(env: Env, origin: string): Record<string, string> {
  const allowed = env.CORS_ORIGIN || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-YouTube-User-Authorization",
  };
  if (allowed && isAllowedOrigin(origin, env)) {
    headers["Access-Control-Allow-Origin"] = allowed;
  }
  return headers;
}

// ── Request handler ────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const debug = env.YT_DEBUG === "1";
    const maxRequests = parseInt(env.RATE_LIMIT_MAX || "200", 10);

    // CORS preflight
    if (request.method === "OPTIONS") {
      const origin = getOrigin(request);
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-YouTube-User-Authorization",
        "Access-Control-Max-Age": "86400",
        ...corsHeaders(env, origin),
      };
      return new Response(null, { status: 204, headers });
    }

    // Rate limiting
    const clientIp =
      request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (isRateLimited(clientIp, maxRequests)) {
      return jsonResponse({ error: "Too many requests" }, 429, { "Retry-After": "60" });
    }

    // Health check
    const isHealthCheck = path === "/api/youtube" || path === "/api/youtube/" || path === "/health";
    if (isHealthCheck) {
      if (!env.AUTH_TOKEN) return jsonResponse({ status: "ok" }, 200);
      const auth = request.headers.get("authorization");
      if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
      if (!verifyToken(token, env.AUTH_TOKEN)) return jsonResponse({ error: "Unauthorized" }, 401);
      return jsonResponse({ status: "ok" }, 200);
    }

    // Auth
    if (env.AUTH_TOKEN) {
      const auth = request.headers.get("authorization");
      if (!auth) return jsonResponse({ error: "Missing Authorization header" }, 401);
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
      if (!verifyToken(token, env.AUTH_TOKEN)) return jsonResponse({ error: "Invalid token" }, 401);
    } else {
      console.warn("[Auth] AUTH_TOKEN not set — proxy is open!");
    }

    // Parse InnerTube path
    const match = path.match(/^\/api\/youtube\/(.+)$/);
    if (!match) {
      return jsonResponse({ error: "Invalid path. Expected /api/youtube/youtubei/v1/..." }, 400);
    }

    const innerTubePath = "/" + match[1];

    if (innerTubePath.includes("://") || innerTubePath.includes("@")) {
      return jsonResponse({ error: "Invalid InnerTube path", path: innerTubePath }, 400);
    }

    // Get session
    let session: SessionState;
    try {
      session = getSession(env);
    } catch (initErr: any) {
      const msg = initErr?.message || String(initErr);
      console.error("[Proxy] Session init failed:", msg);
      if (msg.includes("Cooldown after 403")) {
        return jsonResponse({ error: "YouTube temporarily blocked", retryAfter: 30 }, 503, { "Retry-After": "30" });
      }
      return jsonResponse({ error: "YouTube service unavailable", details: debug ? msg : undefined }, 503);
    }

    // Build target URL
    const targetUrl = new URL(`https://www.youtube.com${innerTubePath}`);
    for (const [key, value] of url.searchParams) {
      targetUrl.searchParams.set(key, value);
    }
    // PoToken is bound to its paired visitor data — sending a stale pot
    // alongside fresh (or freshly generated) visitor data can itself trigger
    // a bot check, so only attach it while we're using the env visitor data.
    if (env.YT_POTOKEN && session.usesEnvVisitor) {
      targetUrl.searchParams.set("pot", env.YT_POTOKEN);
    }

    // Build forward headers
    const forwardHeaders: Record<string, string> = {
      "Content-Type": request.headers.get("content-type") || "application/json",
      "User-Agent": session.userAgent,
      Referer: "https://www.youtube.com/",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://www.youtube.com",
    };
    if (session.apiKey) forwardHeaders["x-youtube-api-key"] = session.apiKey;
    if (session.visitorData) forwardHeaders["x-goog-visitor-id"] = session.visitorData;
    const userAuthorization = request.headers.get("x-youtube-user-authorization");
    if (userAuthorization) {
      forwardHeaders["Authorization"] = userAuthorization;
    } else if (env.YT_COOKIE) {
      forwardHeaders["Cookie"] = env.YT_COOKIE;
    }

    // Inject session context into POST request body
    let requestBody: string | undefined;
    if (request.method === "POST") {
      const bodyText = await request.text();
      if (bodyText) {
        try {
          const bodyObj = JSON.parse(bodyText);
          const proxyCtx = session.context;
          const clientCtx = bodyObj.context || {};

          bodyObj.context = {
            ...clientCtx,
            request: proxyCtx.request || clientCtx.request,
            user: proxyCtx.user || clientCtx.user,
            client: {
              ...clientCtx.client,
              ...(proxyCtx.client?.visitorData ? { visitorData: proxyCtx.client.visitorData } : {}),
            },
          };

          requestBody = JSON.stringify(bodyObj);
        } catch {
          requestBody = bodyText;
        }
      }
    }

    if (debug) {
      console.log(`[Proxy] ${request.method} → ${targetUrl.toString()}`, {
        hasBody: !!requestBody,
        apiKey: !!session.apiKey,
        visitorData: !!session.visitorData,
        clientName: session.clientConfig.clientName,
      });
    }

    try {
      const ytRes = await fetch(targetUrl.toString(), {
        method: request.method || (requestBody ? "POST" : "GET"),
        headers: forwardHeaders,
        body: requestBody,
      });

      if (debug) console.log(`[Proxy] ← ${ytRes.status} ${ytRes.statusText}`);

      if (ytRes.status === 403) {
        invalidateSession();
        const now = Date.now();
        if (now - last403Timestamp > SESSION_BLOCK_WINDOW_MS) {
          recent403Count = 0;
        }
        last403Timestamp = now;
        recent403Count++;
        if (recent403Count >= SESSION_BLOCK_403_THRESHOLD) {
          // This error is not pushed to MixChat as a 503/cooldown — the
          // response is passed through and the session rebuilds fresh (new
          // visitor, no stale PoToken) on the very next request, so a single
          // flagged request never takes the whole proxy down for 30s.
          blockedSessionUntil = now + SESSION_BLOCK_RESET_MS;
          console.error(
            `[Proxy] Repeated 403s — credentials flagged; using fresh visitor data without PoToken for ${SESSION_BLOCK_RESET_MS / 60_000}min`
          );
        } else {
          console.error("[Proxy] YouTube returned 403 — invalidated session");
        }
      }

      const origin = getOrigin(request);
      const responseHeaders: Record<string, string> = {
        "Content-Type": ytRes.headers.get("content-type") || "application/json",
        "Cache-Control": "no-cache",
        ...corsHeaders(env, origin),
      };

      return new Response(ytRes.body, { status: ytRes.status, headers: responseHeaders });
    } catch (error: any) {
      const msg = error?.message || String(error);
      console.error("[Proxy] Request failed:", msg);
      return jsonResponse({ error: "Proxy request failed", details: debug ? msg : undefined }, 502);
    }
  },
};