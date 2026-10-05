import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerBrowseTools } from "./browse.js";
import type { ResolvedTools } from "../config.js";
import type { EmailProvider, EmailSummary } from "../providers/types.js";
import type { Registry } from "../providers/registry.js";
import type { AccountRecord, AccountStore } from "../store/account-store.js";

const tools: ResolvedTools = {
  enabledTools: new Set(["list_emails", "search_emails", "read_email", "read_attachment"]),
  disabledTools: null,
};

interface SearchArgs {
  account?: string;
  query?: string;
  from?: string;
  to?: string;
  cc?: string;
  limit?: number;
}

type Handler = (args: SearchArgs) => Promise<unknown>;
type InputSchema = { parse(input: unknown): SearchArgs };

function account(email: string): AccountRecord {
  return {
    email,
    provider: "imap",
    tokens: {},
    addedAt: "2026-01-01T00:00:00.000Z",
  };
}

function summary(id: string, subject = id): EmailSummary {
  return { id, subject };
}

function store(accounts: AccountRecord[]): AccountStore {
  return {
    listAccounts: vi.fn(() => accounts),
  } as unknown as AccountStore;
}

function provider(items: EmailSummary[] = []): EmailProvider {
  return {
    id: "imap",
    searchEmails: vi.fn(async () => items),
  } as unknown as EmailProvider;
}

function registry(accounts: AccountRecord[], providers: Record<string, EmailProvider>): Registry {
  const byEmail = new Map(accounts.map((rec) => [rec.email, rec]));
  return {
    resolveByEmail: vi.fn((email: string) => {
      const rec = byEmail.get(email);
      if (!rec) throw new Error(`no account registered for "${email}"`);
      return { account: rec, provider: providers[rec.email] };
    }),
  } as unknown as Registry;
}

function registerHandler(store: AccountStore, reg: Registry): Handler {
  let handler: Handler | undefined;
  let inputSchema: InputSchema | undefined;
  const server = {
    registerTool: vi.fn((name: string, config: { inputSchema: InputSchema }, cb: Handler) => {
      if (name === "search_emails") {
        handler = cb;
        inputSchema = config.inputSchema;
      }
    }),
  };

  registerBrowseTools(server as never, { store, registry: reg, tools });
  if (!handler || !inputSchema) throw new Error("search_emails was not registered");
  const registeredHandler = handler;
  const registeredSchema = inputSchema;
  return (args) => registeredHandler(registeredSchema.parse(args));
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function registerBrowseHandler(
  name: string,
  store: AccountStore,
  reg: Registry,
): (args: Record<string, unknown>) => Promise<unknown> {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  let inputSchema: { parse(input: unknown): Record<string, unknown> } | undefined;
  const server = {
    registerTool: vi.fn((registeredName: string, config: {
      inputSchema: { parse(input: unknown): Record<string, unknown> };
    }, cb: (args: Record<string, unknown>) => Promise<unknown>) => {
      if (registeredName === name) {
        handler = cb;
        inputSchema = config.inputSchema;
      }
    }),
  };

  registerBrowseTools(server as never, { store, registry: reg, tools });
  if (!handler || !inputSchema) throw new Error(`${name} was not registered`);
  const registeredHandler = handler;
  const registeredSchema = inputSchema;
  return (args) => registeredHandler(registeredSchema.parse(args));
}

describe("search_emails", () => {
  it("routes an explicit account to one provider and annotates returned items", async () => {
    const a = account("a@example.com");
    const b = account("b@example.com");
    const providerA = provider([summary("a1", "hello")]);
    const providerB = provider([summary("b1", "hello")]);
    const reg = registry([a, b], {
      [a.email]: providerA,
      [b.email]: providerB,
    });
    const handler = registerHandler(store([a, b]), reg);

    const data = structured(await handler({ account: a.email, query: "hello", limit: 5 }));

    expect(reg.resolveByEmail).toHaveBeenCalledTimes(1);
    expect(reg.resolveByEmail).toHaveBeenCalledWith(a.email);
    expect(providerA.searchEmails).toHaveBeenCalledWith(a, {
      query: "hello",
      limit: 5,
    });
    expect(providerB.searchEmails).not.toHaveBeenCalled();
    expect(data).toEqual({
      account: a.email,
      count: 1,
      items: [{ id: "a1", subject: "hello", account: a.email }],
      errors: [],
    });
  });

  it("supports structured-only filters and trims their values", async () => {
    const a = account("a@example.com");
    const providerA = provider();
    const handler = registerHandler(store([a]), registry([a], {
      [a.email]: providerA,
    }));

    await handler({ account: a.email, from: " Alain ", to: " user@example.com ", cc: " Copy " });

    expect(providerA.searchEmails).toHaveBeenCalledWith(a, {
      from: "Alain",
      to: "user@example.com",
      cc: "Copy",
    });
  });

  it("combines free text and structured filters in one options object", async () => {
    const a = account("a@example.com");
    const providerA = provider();
    const handler = registerHandler(store([a]), registry([a], {
      [a.email]: providerA,
    }));

    await handler({ account: a.email, query: "invoice", from: "sender@example.com" });

    expect(providerA.searchEmails).toHaveBeenCalledWith(a, {
      query: "invoice",
      from: "sender@example.com",
    });
  });

  it("rejects calls without a non-empty search criterion", () => {
    const handler = registerHandler(store([]), registry([], {}));

    expect(() => handler({})).toThrow("at least one of query, from, to, or cc is required");
    expect(() => handler({ query: "   " })).toThrow();
  });

  it("searches all accounts in parallel when account is omitted", async () => {
    const a = account("a@example.com");
    const b = account("b@example.com");
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerA = provider();
    const providerB = provider();
    vi.mocked(providerA.searchEmails).mockImplementation(async () => {
      started.push(a.email);
      await gate;
      return [summary("a1")];
    });
    vi.mocked(providerB.searchEmails).mockImplementation(async () => {
      started.push(b.email);
      await gate;
      return [summary("b1")];
    });
    const handler = registerHandler(store([a, b]), registry([a, b], {
      [a.email]: providerA,
      [b.email]: providerB,
    }));

    const result = handler({ query: "invoice", limit: 10 });
    await Promise.resolve();

    expect(started).toEqual([a.email, b.email]);
    release();
    const data = structured(await result);

    expect(providerA.searchEmails).toHaveBeenCalledWith(a, {
      query: "invoice",
      limit: 10,
    });
    expect(providerB.searchEmails).toHaveBeenCalledWith(b, {
      query: "invoice",
      limit: 10,
    });
    expect(data).toEqual({
      account: "all",
      accounts: [a.email, b.email],
      count: 2,
      items: [
        { id: "a1", subject: "a1", account: a.email },
        { id: "b1", subject: "b1", account: b.email },
      ],
      errors: [],
    });
  });

  it("reports per-account errors without discarding successful results", async () => {
    const a = account("a@example.com");
    const b = account("b@example.com");
    const providerA = provider([summary("a1")]);
    const providerB = provider();
    vi.mocked(providerB.searchEmails).mockRejectedValue(new Error("search failed"));
    const handler = registerHandler(store([a, b]), registry([a, b], {
      [a.email]: providerA,
      [b.email]: providerB,
    }));

    const data = structured(await handler({ query: "invoice" }));

    expect(data).toEqual({
      account: "all",
      accounts: [a.email, b.email],
      count: 1,
      items: [{ id: "a1", subject: "a1", account: a.email }],
      errors: [{ account: b.email, message: "search failed" }],
    });
  });

  it("fails clearly when all-account search has no registered accounts", async () => {
    const handler = registerHandler(store([]), registry([], {}));

    const result = await handler({ query: "invoice" });

    expect(result).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: "no accounts registered. Call add_account first." },
      ],
    });
  });

  it("preserves a native web link on each multi-account search result", async () => {
    const a = account("a@example.com");
    const b = account("b@example.com");
    const providerA = provider([{ ...summary("a1"), webUrl: "https://outlook.office.com/mail/a1" }]);
    const providerB = provider([{ ...summary("b1"), webUrlUnavailableReason: "IMAP does not expose native web links." }]);
    const handler = registerHandler(store([a, b]), registry([a, b], {
      [a.email]: providerA,
      [b.email]: providerB,
    }));

    const data = structured(await handler({ query: "invoice" }));

    expect(data.items).toEqual([
      { id: "a1", subject: "a1", webUrl: "https://outlook.office.com/mail/a1", account: a.email },
      { id: "b1", subject: "b1", webUrlUnavailableReason: "IMAP does not expose native web links.", account: b.email },
    ]);
  });
});

describe("browse web links", () => {
  it("preserves repeated unavailable reasons for every IMAP-style list item", async () => {
    const acct = account("imap@example.com");
    const reason = "IMAP does not expose native web links.";
    const prov = {
      id: "imap",
      listEmails: vi.fn(async () => ({
        items: [
          { ...summary("1"), webUrlUnavailableReason: reason },
          { ...summary("2"), webUrlUnavailableReason: reason },
        ],
        hasMore: false,
      })),
    } as unknown as EmailProvider;
    const handler = registerBrowseHandler("list_emails", store([acct]), registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email }));

    expect(data.items).toEqual([
      { id: "1", subject: "1", webUrlUnavailableReason: reason },
      { id: "2", subject: "2", webUrlUnavailableReason: reason },
    ]);
  });

  it("includes the native link on a full email read", async () => {
    const acct = account("a@example.com");
    const prov = {
      id: "outlook",
      readEmail: vi.fn(async () => ({
        id: "message-1",
        subject: "Hello",
        bodyText: "Body",
        webUrl: "https://outlook.office.com/mail/message-1",
      })),
    } as unknown as EmailProvider;
    const handler = registerBrowseHandler("read_email", store([acct]), registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email, id: "message-1" }));

    expect(data).toMatchObject({
      id: "message-1",
      webUrl: "https://outlook.office.com/mail/message-1",
      body: "Body",
    });
  });

  it("includes the parent message link on an attachment result", async () => {
    const acct = account("a@example.com");
    const prov = {
      id: "outlook",
      readAttachment: vi.fn(async () => ({
        name: "report.pdf",
        contentType: "application/pdf",
        path: "/tmp/report.pdf",
        webUrl: "https://outlook.office.com/mail/message-1",
      })),
    } as unknown as EmailProvider;
    const handler = registerBrowseHandler("read_attachment", store([acct]), registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({
      account: acct.email,
      messageId: "message-1",
      attachmentId: "attachment-1",
    }));

    expect(data).toEqual({
      name: "report.pdf",
      contentType: "application/pdf",
      path: "/tmp/report.pdf",
      webUrl: "https://outlook.office.com/mail/message-1",
    });
  });
});

describe("read_email MCP format contract", () => {
  it("defaults to Markdown, exposes explicit HTML and rejects text before provider reads", async () => {
    const rec = account("user@example.com");
    let body: { bodyHtml?: string; bodyText?: string } = { bodyHtml: "<p>Hello <strong>Alice</strong>.</p>" };
    const readEmail = vi.fn(async () => ({ id: "message", subject: "Subject", ...body }));
    const backend = { id: "imap", readEmail } as unknown as EmailProvider;
    const server = new McpServer({ name: "read-contract", version: "1" });
    registerBrowseTools(server, { store: store([rec]), registry: registry([rec], { [rec.email]: backend }), tools });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const args = { account: rec.email, id: "message" };
      const markdown = await client.callTool({ name: "read_email", arguments: args });
      expect(markdown.structuredContent).toMatchObject({ body: "Hello **Alice**.", bodyFormat: "markdown" });
      const html = await client.callTool({ name: "read_email", arguments: { ...args, format: "html" } });
      expect(html.structuredContent).toMatchObject({ body: body.bodyHtml, bodyFormat: "html" });
      const calls = readEmail.mock.calls.length;
      const invalid = await client.callTool({ name: "read_email", arguments: { ...args, format: "text" } });
      expect(invalid.isError).toBe(true);
      expect(readEmail).toHaveBeenCalledTimes(calls);
      body = { bodyText: "Literal *text* <not-html>" };
      expect((await client.callTool({ name: "read_email", arguments: args })).structuredContent).toMatchObject({ body: body.bodyText, bodyFormat: "markdown" });
      body = {};
      expect((await client.callTool({ name: "read_email", arguments: args })).structuredContent).toMatchObject({ body: "", bodyFormat: "markdown" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
