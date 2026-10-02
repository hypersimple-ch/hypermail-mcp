import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";

import { AccountStore } from "./store/account-store.js";
import { resolveDataDir } from "./store/crypto.js";
import { buildRegistry, type Registry } from "./providers/registry.js";
import { registerTools } from "./tools/index.js";
import { createLogger } from "./logger.js";
import { VERSION } from "./version.js";
import { DEFAULT_GMAIL_OAUTH_CALLBACK_PATH } from "./providers/gmail/auth.js";
import type { AppConfig, ResolvedTools } from "./config.js";
import { resolveTools } from "./config.js";

export interface ServerOptions {
  /** Fully resolved application config from environment plus CLI overrides. */
  config: AppConfig;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const { config } = opts;
  const logger = createLogger({ enabled: config.debugLogging });
  const dataDir = resolveDataDir(config.dataDir);
  logger.debug("server", "startup", {
    version: VERSION,
    transport: config.transport,
    dataDir,
    toolsEnabled: config.tools?.enabled ?? null,
    toolsDisabled: config.tools?.disabled ?? null,
  });
  const store = await AccountStore.open({ dataDir, logger });
  const registry = buildRegistry({ store, providers: config.providers, logger });
  const tools: ResolvedTools = resolveTools(config);

  // Factory: creates a fresh McpServer with all tools registered.
  // HTTP mode creates one per session; stdio mode uses a single instance.
  const createServer = (): McpServer => {
    const s = new McpServer(
      { name: "hypermail-mcp", version: VERSION },
      { capabilities: { tools: {}, logging: {} } },
    );
    registerTools(s, { store, registry, tools, logger });
    return s;
  };

  if (config.transport === "http") {
    await startHttp(createServer, registry, config.http.host, config.http.port);
  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestBaseUrl(req: IncomingMessage): string {
  const proto = firstHeader(req.headers["x-forwarded-proto"]) ?? "http";
  const host =
    firstHeader(req.headers["x-forwarded-host"]) ??
    firstHeader(req.headers.host) ??
    "127.0.0.1";
  return `${proto}://${host}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendOAuthHtml(res: ServerResponse, status: number, title: string, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>
</html>`);
}

async function handleGmailOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  registry: Registry,
): Promise<void> {
  const provider = registry.get("gmail");
  if (!provider.completeAddAccountFromRedirect) {
    sendOAuthHtml(res, 500, "Gmail authorization failed", "This server cannot complete Gmail OAuth callbacks.");
    return;
  }

  const authorizationResponse = new URL(req.url ?? "", requestBaseUrl(req)).toString();
  const result = await provider.completeAddAccountFromRedirect(authorizationResponse);
  if (result.status === "ready") {
    sendOAuthHtml(res, 200, "Gmail authorization complete", "You can close this tab and return to your MCP client.");
    return;
  }

  sendOAuthHtml(
    res,
    400,
    "Gmail authorization failed",
    result.status === "error"
      ? result.error ?? "Unknown Gmail OAuth error."
      : "The Gmail OAuth flow was not ready. Restart account setup and try again.",
  );
}

const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;

function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

// Event-based reading lets rejected requests drain without retaining their remaining bytes.
function readPostBody(req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | undefined> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        rejected = true;
        chunks = [];
        sendRpcError(res, 413, -32000, "Request body too large");
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (rejected) return;
      try {
        resolve({ body: JSON.parse(Buffer.concat(chunks, size).toString("utf8")) });
      } catch {
        sendRpcError(res, 400, -32700, "Parse error");
        resolve(undefined);
      }
    });
    req.once("error", reject);
    req.once("aborted", () => reject(new Error("HTTP request aborted")));
  });
}

export async function startHttp(
  createServer: () => McpServer,
  registry: Registry,
  host: string,
  port: number,
): Promise<HttpServer> {
  const sessions = new Map<string, HttpSession>();
  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    let allocated: HttpSession | undefined;
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && pathname === DEFAULT_GMAIL_OAUTH_CALLBACK_PATH) {
        await handleGmailOAuthCallback(req, res, registry);
        return;
      }
      if (pathname !== "/mcp") {
        res.writeHead(404);
        res.end("not found");
        req.resume();
        return;
      }
      if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) {
        res.writeHead(405, { Allow: "GET, POST, DELETE" });
        res.end("method not allowed");
        req.resume();
        return;
      }
      const sessionId = firstHeader(req.headers["mcp-session-id"]);
      let session = sessionId !== undefined ? sessions.get(sessionId) : undefined;
      if (sessionId !== undefined && !session) {
        sendRpcError(res, 404, -32001, "Session not found");
        req.resume();
        return;
      }
      let body: unknown;
      if (req.method === "POST") {
        const parsed = await readPostBody(req, res);
        if (!parsed) return;
        body = parsed.body;
      }
      if (!session) {
        // Only recognize intent here; the SDK owns initialization schema validation.
        if (req.method !== "POST" || !body || typeof body !== "object" ||
            Array.isArray(body) || !("method" in body) || body.method !== "initialize") {
          sendRpcError(res, 400, -32000, "Initialization required");
          req.resume();
          return;
        }
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, server });
          },
          onsessionclosed: (sid: string) => {
            sessions.delete(sid);
          },
        });
        allocated = { transport, server };
        await server.connect(transport);
        session = allocated;
      }
      await session.transport.handleRequest(req, res, body);
    } catch {
      // Never log request bodies or provider credentials from arbitrary error objects.
      console.error("[hypermail-mcp] HTTP request failed");
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("internal error");
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      if (allocated && (!allocated.server.server.getClientVersion() || res.statusCode >= 400)) {
        if (allocated.transport.sessionId) sessions.delete(allocated.transport.sessionId);
        try {
          await allocated.server.close();
        } catch {
          console.error("[hypermail-mcp] Failed to close rejected HTTP initialization");
        }
      }
    }
  });
  http.on("close", () => {
    for (const session of sessions.values()) {
      void session.server.close().catch(() => {
        console.error("[hypermail-mcp] Failed to close HTTP session");
      });
    }
    sessions.clear();
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  console.error(`[hypermail-mcp] listening on http://${host}:${port}/mcp`);
  return http;
}
