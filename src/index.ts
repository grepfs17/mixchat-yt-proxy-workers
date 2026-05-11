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
}

// ── Constants ──────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000;
const COOLDOWN_AFTER_403_MS = 30_000;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CLIENTS: Record<string, ClientConfig> = {
  WEB: {
    clientName: "WEB",
    clientVersion: "2.20250512.00.00",
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

function generateVisitorData(): string {
  const randBytes = new Uint8Array(16);
  crypto.getRandomValues(randBytes);
  const id = Array.from(randBytes, (b) => b.toString(16).padStart(2, "0")).join("");

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

function invalidateSession(): void {
  sessionState = null;
}

function getClientConfig(clientType: string, env: Env): ClientConfig {
  let ct = (clientType || "WEB").toUpperCase();
  if (ct === "TV") ct = "TVHTML5";
  if (ct === "TVHTML5_TV") ct = "TVHTML5_SIMPLY_EMBEDDED_PLAYER";
  const config = CLIENTS[ct] || CLIENTS["WEB"];
  return { ...config, userAgent: env.YT_USER_AGENT || config.userAgent };
}

function initSession(env: Env): SessionState {
  const clientConfig = getClientConfig(env.YT_CLIENT || "WEB", env);
  const visitorData = env.YT_VISITOR_DATA || generateVisitorData();
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

  return { visitorData, apiKey: clientConfig.apiKey, context, userAgent: clientConfig.userAgent, clientConfig };
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
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
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
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
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
    if (env.YT_POTOKEN) {
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
    if (env.YT_COOKIE) forwardHeaders["Cookie"] = env.YT_COOKIE;

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
        last403Time = Date.now();
        console.error("[Proxy] YouTube returned 403 — invalidated session");
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