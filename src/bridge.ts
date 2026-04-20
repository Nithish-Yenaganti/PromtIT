import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { promptItServer } from "./promptServer";
import { startEmbeddingWarmup } from "./memory/embeddings";

const BRIDGE_HOST = process.env.PROMPTIT_BRIDGE_HOST?.trim() || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.PROMPTIT_BRIDGE_PORT || "8787");
const AUTH_MODE = (process.env.PROMPTIT_BRIDGE_AUTH_MODE?.trim() || "api_key").toLowerCase();
const BRIDGE_API_KEY = process.env.PROMPTIT_BRIDGE_API_KEY?.trim();
const OAUTH_CLIENT_ID = process.env.PROMPTIT_OAUTH_CLIENT_ID?.trim();
const OAUTH_CLIENT_SECRET = process.env.PROMPTIT_OAUTH_CLIENT_SECRET?.trim();
const OAUTH_TOKEN_TTL_SECONDS = Number(process.env.PROMPTIT_OAUTH_TOKEN_TTL_SECONDS || "3600");
const ALLOWED_ORIGINS = new Set(
  (process.env.PROMPTIT_BRIDGE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);

if (!Number.isFinite(BRIDGE_PORT) || BRIDGE_PORT <= 0) {
  throw new Error("PROMPTIT_BRIDGE_PORT must be a valid positive number.");
}
if (!Number.isFinite(OAUTH_TOKEN_TTL_SECONDS) || OAUTH_TOKEN_TTL_SECONDS <= 0 || OAUTH_TOKEN_TTL_SECONDS > 86400) {
  throw new Error("PROMPTIT_OAUTH_TOKEN_TTL_SECONDS must be between 1 and 86400.");
}
if (!["none", "api_key", "oauth_client_credentials"].includes(AUTH_MODE)) {
  throw new Error("PROMPTIT_BRIDGE_AUTH_MODE must be one of: none, api_key, oauth_client_credentials.");
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

if (AUTH_MODE === "api_key" && !BRIDGE_API_KEY) {
  throw new Error("PROMPTIT_BRIDGE_API_KEY is required when auth mode is api_key.");
}
if (AUTH_MODE === "oauth_client_credentials" && (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET)) {
  throw new Error("PROMPTIT_OAUTH_CLIENT_ID and PROMPTIT_OAUTH_CLIENT_SECRET are required for oauth_client_credentials mode.");
}
if (!isLoopbackHost(BRIDGE_HOST) && AUTH_MODE === "none") {
  throw new Error("AUTH_MODE=none is not allowed on non-loopback hosts. Use api_key or oauth_client_credentials.");
}

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});

await promptItServer.connect(transport);
startEmbeddingWarmup();

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return isLoopbackOrigin(origin);
}

function withCors(res: Response, origin: string | null): Response {
  const headers = new Headers(res.headers);
  if (origin && isOriginAllowed(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID, X-PromptIT-Api-Key, Authorization"
  );
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

type OAuthTokenRecord = {
  token: string;
  expiresAtMs: number;
  clientId: string;
  scope: string;
};

const oauthTokens = new Map<string, OAuthTokenRecord>();

function pruneOAuthTokens() {
  const now = Date.now();
  for (const [token, record] of oauthTokens.entries()) {
    if (record.expiresAtMs <= now) oauthTokens.delete(token);
  }
}

function issueOAuthToken(clientId: string, scope: string): OAuthTokenRecord {
  pruneOAuthTokens();
  const token = crypto.randomUUID();
  const expiresAtMs = Date.now() + OAUTH_TOKEN_TTL_SECONDS * 1000;
  const record: OAuthTokenRecord = { token, expiresAtMs, clientId, scope };
  oauthTokens.set(token, record);
  return record;
}

async function parseOAuthTokenRequest(req: Request): Promise<URLSearchParams> {
  const body = await req.text();
  return new URLSearchParams(body);
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

function oauthUnauthorized(origin: string | null): Response {
  const metadataUrl = `http://${BRIDGE_HOST}:${BRIDGE_PORT}/.well-known/oauth-authorization-server`;
  const res = Response.json({ error: "Unauthorized" }, { status: 401 });
  const headers = new Headers(res.headers);
  headers.set("WWW-Authenticate", `Bearer realm=\"prompt-it\", resource_metadata=\"${metadataUrl}\"`);
  return withCors(
    new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    }),
    origin
  );
}

function authorizeRequest(req: Request, origin: string | null): Response | null {
  if (AUTH_MODE === "none") return null;

  if (AUTH_MODE === "api_key") {
    const keyHeader = req.headers.get("x-promptit-api-key");
    const bearer = extractBearerToken(req);
    const provided = keyHeader || bearer;
    if (!provided || provided !== BRIDGE_API_KEY) {
      return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), origin);
    }
    return null;
  }

  const bearer = extractBearerToken(req);
  if (!bearer) return oauthUnauthorized(origin);

  pruneOAuthTokens();
  const record = oauthTokens.get(bearer);
  if (!record || record.expiresAtMs <= Date.now()) {
    oauthTokens.delete(bearer);
    return oauthUnauthorized(origin);
  }
  return null;
}

function createBridgeServer(port: number) {
  return Bun.serve({
    hostname: BRIDGE_HOST,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");

      if (!isOriginAllowed(origin)) {
        return withCors(Response.json({ error: "Origin not allowed" }, { status: 403 }), origin);
      }

      if (req.method === "OPTIONS" && url.pathname === "/mcp") {
        return withCors(new Response(null, { status: 204 }), origin);
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (AUTH_MODE !== "oauth_client_credentials") {
          return withCors(Response.json({ error: "Not found" }, { status: 404 }), origin);
        }
        const base = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
        return withCors(
          Response.json({
            issuer: base,
            token_endpoint: `${base}/oauth/token`,
            grant_types_supported: ["client_credentials"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          }),
          origin
        );
      }

      if (url.pathname === "/oauth/token") {
        if (AUTH_MODE !== "oauth_client_credentials") {
          return withCors(Response.json({ error: "Not found" }, { status: 404 }), origin);
        }
        if (req.method !== "POST") {
          return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), origin);
        }

        const params = await parseOAuthTokenRequest(req);
        const grantType = params.get("grant_type");
        const clientId = params.get("client_id");
        const clientSecret = params.get("client_secret");
        const scope = params.get("scope") || "mcp";

        if (grantType !== "client_credentials") {
          return withCors(
            Response.json(
              { error: "unsupported_grant_type", error_description: "Only client_credentials is supported." },
              { status: 400 }
            ),
            origin
          );
        }

        if (clientId !== OAUTH_CLIENT_ID || clientSecret !== OAUTH_CLIENT_SECRET) {
          return withCors(Response.json({ error: "invalid_client" }, { status: 401 }), origin);
        }

        const tokenRecord = issueOAuthToken(clientId!, scope);
        const expiresIn = Math.max(1, Math.floor((tokenRecord.expiresAtMs - Date.now()) / 1000));

        return withCors(
          Response.json({
            access_token: tokenRecord.token,
            token_type: "Bearer",
            expires_in: expiresIn,
            scope: tokenRecord.scope,
          }),
          origin
        );
      }

      if (url.pathname === "/health") {
        const authError = authorizeRequest(req, origin);
        if (authError) return authError;
        return withCors(
          Response.json({
            ok: true,
            service: "prompt-it-bridge",
            transport: "streamable-http",
            auth_mode: AUTH_MODE,
            endpoint: "/mcp",
          }),
          origin
        );
      }

      if (url.pathname === "/mcp") {
        if (!["GET", "POST", "DELETE"].includes(req.method)) {
          return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), origin);
        }

        const authError = authorizeRequest(req, origin);
        if (authError) return authError;

        try {
          const res = await transport.handleRequest(req);
          return withCors(res, origin);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`Bridge transport error: ${message}\n`);
          return withCors(Response.json({ error: "Bridge request failed" }, { status: 500 }), origin);
        }
      }

      return withCors(Response.json({ error: "Not found" }, { status: 404 }), origin);
    },
  });
}

const server = createBridgeServer(BRIDGE_PORT);

process.stderr.write(
  `PromptIT MCP bridge listening on http://${server.hostname}:${server.port} (MCP endpoint: /mcp, auth_mode: ${AUTH_MODE})\n`
);
