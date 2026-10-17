import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ZodType } from "zod";
import { describe, expect, it, vi } from "vitest";

import { registerAccountTools } from "./accounts.js";
import type { ResolvedTools } from "../config.js";
import type { Registry } from "../providers/registry.js";

import { AccountStore } from "../store/account-store.js";
import type { AccountRecord } from "../store/account-store.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const tools: ResolvedTools = {
  enabledTools: new Set(["add_account", "complete_add_account"]),
  disabledTools: null,
};

const secretAccount: AccountRecord = {
  email: "user@example.com",
  provider: "imap",
  displayName: "User",
  tokens: {
    password: "secret-password",
    refreshToken: "secret-refresh-token",
  },
  addedAt: "2026-01-01T00:00:00.000Z",
  signature: "<p>Regards</p>",
};

function registerHandlers(provider: Record<string, unknown>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
    }),
  };
  const registry = {
    get: vi.fn(() => provider),
  } as unknown as Registry;

  registerAccountTools(server as never, {
    store: {} as AccountStore,
    registry,
    tools,
  });

  return handlers;
}

function structured(result: unknown): Record<string, unknown> | undefined {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
}

function textJson(result: unknown): unknown {
  const text = (result as { content?: Array<{ text: string }> }).content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

describe("account tools", () => {
  it("redacts tokens from ready add_account responses", async () => {
    const handlers = registerHandlers({
      addAccount: vi.fn(async () => ({ status: "ready", account: secretAccount })),
    });
    const handler = handlers.get("add_account");
    if (!handler) throw new Error("add_account was not registered");

    const result = await handler({ provider: "imap", email: secretAccount.email });

    expect(structured(result)).toEqual({
      status: "ready",
      account: {
        email: "user@example.com",
        provider: "imap",
        displayName: "User",
        addedAt: "2026-01-01T00:00:00.000Z",
        signature: "<p>Regards</p>",
        style: undefined,
      },
    });
    const rendered = JSON.stringify(textJson(result));
    expect(rendered).not.toContain("tokens");
    expect(rendered).not.toContain("secret-password");
    expect(rendered).not.toContain("secret-refresh-token");
  });

  it("redacts tokens from ready complete_add_account responses", async () => {
    const handlers = registerHandlers({
      addAccount: vi.fn(),
      completeAddAccount: vi.fn(async () => ({ status: "ready", account: secretAccount })),
    });
    const handler = handlers.get("complete_add_account");
    if (!handler) throw new Error("complete_add_account was not registered");

    const result = await handler({ provider: "gmail", handle: "handle-1" });

    expect(structured(result)).toMatchObject({
      status: "ready",
      account: {
        email: "user@example.com",
        provider: "imap",
        displayName: "User",
      },
    });
    const rendered = JSON.stringify(textJson(result));
    expect(rendered).not.toContain("tokens");
    expect(rendered).not.toContain("secret-password");
    expect(rendered).not.toContain("secret-refresh-token");
  });
});

async function withSettingsStore(
  fn: (store: AccountStore, dataDir: string, set: Handler) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hypermail-settings-test-"));
  const key = Buffer.alloc(32, 9);
  try {
    const store = await AccountStore.open({ dataDir, key });
    await store.upsertAccount({ ...secretAccount, style: { fontFamily: "serif" } });
    let set!: Handler;
    const server = {
      registerTool(name: string, config: { inputSchema: ZodType<Record<string, unknown>> }, handler: Handler) {
        if (name === "set_account_settings") {
          set = async (args) => handler(config.inputSchema.parse(args));
        }
      },
    };
    registerAccountTools(server as never, {
      store,
      registry: {} as Registry,
      tools: { enabledTools: new Set(["set_account_settings"]), disabledTools: null },
    });
    await fn(store, dataDir, set);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function withProviderSettingsStore(
  account: AccountRecord,
  provider: Record<string, unknown>,
  fn: (dataDir: string, handlers: Map<string, Handler>) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hypermail-provider-settings-test-"));
  const key = Buffer.alloc(32, 9);
  try {
    const store = await AccountStore.open({ dataDir, key });
    await store.upsertAccount(account);
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool(name: string, config: { inputSchema: ZodType<Record<string, unknown>> }, handler: Handler) {
        handlers.set(name, async (args) => handler(config.inputSchema.parse(args)));
      },
    };
    registerAccountTools(server as never, {
      store,
      registry: { get: () => provider } as unknown as Registry,
      tools: {
        enabledTools: new Set(["get_account_settings", "set_account_settings", "list_accounts"]),
        disabledTools: null,
      },
    });
    await fn(dataDir, handlers);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("Gmail account settings", () => {
  const gmailAccount: AccountRecord = {
    ...secretAccount,
    provider: "gmail",
    signature: "<i>Local</i>",
    style: { fontFamily: "serif" },
  };

  it.each([
    { name: "prefers native over local", native: "<b>Native</b>", local: "<i>Local</i>", expected: "<b>Native</b>" },
    { name: "uses native without a local signature", native: "<b>Native</b>", local: undefined, expected: "<b>Native</b>" },
    { name: "falls back after an empty native response", native: "", local: "<i>Local</i>", expected: "<i>Local</i>" },
    { name: "falls back after an absent native response", native: undefined, local: "<i>Local</i>", expected: "<i>Local</i>" },
    { name: "returns null when neither source exists", native: undefined, local: undefined, expected: null },
  ])("$name", async ({ native, local, expected }) => {
    await withProviderSettingsStore(
      { ...gmailAccount, signature: local },
      { getSignature: async () => native },
      async (dataDir, handlers) => {
        const result = await handlers.get("get_account_settings")!({ account: gmailAccount.email });
        expect(structured(result)).toEqual({
          signature: expected,
          style: gmailAccount.style,
        });
        const reopened = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 9) });
        expect(reopened.getAccount(gmailAccount.email)?.signature).toBe(local);
        expect(reopened.getAccount(gmailAccount.email)?.style).toEqual(gmailAccount.style);
      },
    );
  });

  it("returns native lookup errors rather than the configured local fallback", async () => {
    await withProviderSettingsStore(
      gmailAccount,
      { getSignature: async () => { throw new Error("Gmail settings unavailable"); } },
      async (dataDir, handlers) => {
        const result = await handlers.get("get_account_settings")!({ account: gmailAccount.email });
        expect(result).toMatchObject({
          isError: true,
          content: [{ type: "text", text: "Gmail settings unavailable" }],
        });
        const reopened = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 9) });
        expect(reopened.getAccount(gmailAccount.email)?.signature).toBe(gmailAccount.signature);
      },
    );
  });

  it("saves and clears only local settings and lists local signature presence without a native request", async () => {
    const getSignature = vi.fn(async () => "<b>Native</b>");
    await withProviderSettingsStore(gmailAccount, { getSignature }, async (dataDir, handlers) => {
      const set = handlers.get("set_account_settings")!;
      const list = handlers.get("list_accounts")!;
      expect(structured(await list({}))).toMatchObject({
        accounts: [{ email: gmailAccount.email, hasSignature: true, hasStyle: true }],
      });

      const saved = await set({ account: gmailAccount.email, signature: "<u>Updated local</u>" });
      expect(structured(saved)).toEqual({
        signature: "<u>Updated local</u>",
        style: gmailAccount.style,
      });
      const afterSave = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 9) });
      expect(afterSave.getAccount(gmailAccount.email)).toMatchObject({
        signature: "<u>Updated local</u>",
        style: gmailAccount.style,
      });

      const cleared = await set({ account: gmailAccount.email, signature: "" });
      expect(structured(cleared)).toEqual({ signature: null, style: gmailAccount.style });
      const afterClear = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 9) });
      expect(afterClear.getAccount(gmailAccount.email)?.signature).toBeUndefined();
      expect(afterClear.getAccount(gmailAccount.email)?.style).toEqual(gmailAccount.style);
      expect(structured(await list({}))).toMatchObject({
        accounts: [{ email: gmailAccount.email, hasSignature: false, hasStyle: true }],
      });
      expect(getSignature).not.toHaveBeenCalled();
    });
  });
});

describe("set_account_settings", () => {
  it("accepts null style and persists clearing without changing omitted signature", async () => {
    await withSettingsStore(async (_store, dataDir, set) => {
      const result = await set({ account: secretAccount.email, style: null });
      expect(structured(result)).toEqual({ signature: secretAccount.signature, style: null });
      const reopened = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 9) });
      expect(reopened.getAccount(secretAccount.email)?.style).toBeUndefined();
      expect(reopened.getAccount(secretAccount.email)?.signature).toBe(secretAccount.signature);
    });
  });

  it("preserves refreshed tokens and concurrently changed omitted style during a file read", async () => {
    await withSettingsStore(async (store, dataDir, set) => {
      // Executor gates support the project's Node 20 minimum (withResolvers needs Node 22).
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reading = new Promise<void>((resolve) => { started = resolve; });
      const read = vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
        started();
        await gate;
        return "<p>Updated</p>";
      });
      const pending = set({ account: secretAccount.email, signaturePath: "isolated-test-signature" });
      await reading;
      read.mockRestore();
      const fresh = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 9) });
      await fresh.updateTokens(secretAccount.email, { refreshed: true });
      await fresh.updateSettings(secretAccount.email, { style: { fontColor: "blue" } });
      release();
      expect(structured(await pending)).toEqual({
        signature: "<p>Updated</p>", style: { fontColor: "blue" },
      });
      const reopened = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 9) });
      expect(reopened.getAccount(secretAccount.email)).toMatchObject({
        tokens: { refreshed: true }, style: { fontColor: "blue" }, signature: "<p>Updated</p>",
      });
      expect(store.getAccount(secretAccount.email)?.tokens).toEqual({ refreshed: true });
    });
  });

  it("does not recreate an account removed while reading a signature file", async () => {
    await withSettingsStore(async (store, dataDir, set) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const read = vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
        await gate;
        return "new signature";
      });
      const pending = set({ account: secretAccount.email, signaturePath: "isolated-test-signature" });
      read.mockRestore();
      await store.removeAccount(secretAccount.email);
      release();
      expect(await pending).toMatchObject({ isError: true });
      const reopened = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 9) });
      expect(reopened.getAccount(secretAccount.email)).toBeUndefined();
    });
  });

  it.each(["inline", "file"])("clears an empty %s signature and retains omitted style", async (kind) => {
    await withSettingsStore(async (_store, dataDir, set) => {
      const signaturePath = path.join(dataDir, "signature.html");
      await fs.writeFile(signaturePath, "");
      const result = await set({
        account: secretAccount.email,
        ...(kind === "inline" ? { signature: "" } : { signaturePath }),
      });
      expect(structured(result)).toEqual({ signature: null, style: { fontFamily: "serif" } });
      const reopened = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 9) });
      expect(reopened.getAccount(secretAccount.email)?.signature).toBeUndefined();
      expect(reopened.getAccount(secretAccount.email)?.style).toEqual({ fontFamily: "serif" });
    });
  });
});
