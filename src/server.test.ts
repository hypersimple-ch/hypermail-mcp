import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AccountStore } from "./store/account-store.js";
import type { Registry } from "./providers/registry.js";
import { registerTools } from "./tools/index.js";
import { startHttp } from "./server.js";

const rpcHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const toolList = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const initialize = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "http-test", version: "1" } },
};

describe("HTTP MCP boundary", () => {
  let http: Server;
  let url: URL;
  let created: McpServer[];
  let clients: Client[];
  let registry: Registry;

  beforeEach(async () => {
    created = [];
    clients = [];
    const store = { listAccounts: () => [] } as unknown as AccountStore;
    registry = {
      get: vi.fn(() => { throw new Error("Unexpected provider access"); }),
      resolveByEmail: vi.fn(() => { throw new Error("Unexpected mailbox access"); }),
    } as unknown as Registry;
    http = await startHttp(() => {
      const server = new McpServer({ name: "isolated-http-test", version: "1" });
      registerTools(server, {
        store, registry,
        tools: { enabledTools: new Set(["list_accounts"]), disabledTools: null },
      });
      created.push(server);
      return server;
    }, registry, "127.0.0.1", 0);
    url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  });

  afterEach(async () => {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all(created.map(server => server.close()));
    const closing = new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    http.closeAllConnections();
    await closing;
  });

  async function connect() {
    const client = new Client({ name: "http-test", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    return { client, transport };
  }

  async function post(body: unknown, sessionId?: string, target = url) {
    return fetch(target, {
      method: "POST",
      headers: { ...rpcHeaders, ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId }) },
      body: JSON.stringify(body),
    });
  }

  async function assertRecovered() {
    const { client, transport } = await connect();
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["list_accounts"]);
    expect((await client.callTool({ name: "list_accounts", arguments: {} })).structuredContent).toEqual({ accounts: [] });
    await transport.terminateSession();
  }

  it("initializes, calls a real tool, closes, and rejects expired session IDs without allocation", async () => {
    const { client, transport } = await connect();
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["list_accounts"]);
    expect((await client.callTool({ name: "list_accounts", arguments: {} })).structuredContent).toEqual({ accounts: [] });
    const sid = transport.sessionId!;
    await transport.terminateSession();
    const expired = await post(toolList, sid);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toMatchObject({ error: { code: -32001 }, id: null });
    expect(created).toHaveLength(1);
    await assertRecovered();
  });

  it("requires initialization and rejects unknown supplied IDs before allocating", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(url, { method, headers: rpcHeaders });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: -32000 }, id: null });
    }
    const missing = await post(toolList);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: -32000 } });
    const unknown = await post(initialize, "expired-test-session");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: -32001 } });
    expect(created).toHaveLength(0);
    await assertRecovered();
  });

  it("uses an exact pathname, accepts query strings, and advertises supported methods", async () => {
    const wrong = await post(initialize, undefined, new URL("/mcp-extra", url));
    expect(wrong.status).toBe(404);
    const unsupported = await fetch(url, { method: "PUT" });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("allow")).toBe("GET, POST, DELETE");
    expect(created).toHaveLength(0);
    const response = await post(initialize, undefined, new URL("/mcp?client=test", url));
    expect(response.status).toBe(200);
    const sid = response.headers.get("mcp-session-id")!;
    await response.text();
    expect((await fetch(url, { method: "DELETE", headers: { ...rpcHeaders, "Mcp-Session-Id": sid } })).status).toBe(200);
    await assertRecovered();
  });

  it("returns a JSON-RPC parse error and leaves existing sessions usable", async () => {
    const { client, transport } = await connect();
    const response = await fetch(url, {
      method: "POST", headers: { ...rpcHeaders, "Mcp-Session-Id": transport.sessionId! }, body: "{bad",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 }, id: null });
    expect((await client.callTool({ name: "list_accounts", arguments: {} })).structuredContent).toEqual({ accounts: [] });
    await transport.terminateSession();
    const empty = await fetch(url, { method: "POST", headers: rpcHeaders, body: "" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: { code: -32700 }, id: null });
    await assertRecovered();
  });

  it("limits a chunked body without Content-Length and recovers after rejecting it", async () => {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: rpcHeaders }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      req.on("error", reject);
      const chunk = Buffer.alloc(1024 * 1024, 32);
      for (let i = 0; i < 17; i++) req.write(chunk);
      req.end();
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: -32000 }, id: null });
    expect(created).toHaveLength(0);
    await assertRecovered();
  });

  it("cleans up SDK-rejected initialization instead of retaining an orphaned session", async () => {
    const response = await post({ ...initialize, params: {} });
    const sid = response.headers.get("mcp-session-id");
    const body = await response.text();
    expect(body).toContain("error");
    expect(created).toHaveLength(1);
    await vi.waitFor(() => expect(created[0]!.server.transport).toBeUndefined());
    if (sid) {
      const expired = await post(toolList, sid);
      expect(expired.status).toBe(404);
      expect(await expired.json()).toMatchObject({ error: { code: -32001 } });
    }
    await assertRecovered();
  });

  it("rejects startup on a listen error", async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
    try {
      await expect(startHttp(() => { throw new Error("No session allocation expected"); }, registry,
        "127.0.0.1", (occupied.address() as AddressInfo).port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
    }
  });
});
