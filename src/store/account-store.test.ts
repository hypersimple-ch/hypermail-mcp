import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLogger } from "../logger.js";
import { AccountStore, type AccountRecord } from "./account-store.js";

const key = Buffer.alloc(32, 7);

function account(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    email: "a@example.com",
    provider: "outlook",
    tokens: { initial: true },
    addedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function withDataDir<T>(fn: (dataDir: string) => Promise<T>): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hypermail-account-store-"));
  try {
    return await fn(dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function withStore<T>(fn: (store: AccountStore) => Promise<T>): Promise<T> {
  return withDataDir(async (dataDir) => {
    const store = await AccountStore.open({ dataDir, key });
    return await fn(store);
  });
}

describe("AccountStore", () => {
  it("patches settings against refreshed persisted state without overwriting other fields", async () => {
    await withDataDir(async (dataDir) => {
      const stale = await AccountStore.open({ dataDir, key });
      const original = account({
        signature: "old",
        style: { fontFamily: "serif" },
        displayName: "Original",
        newEmailCheckpoint: { receivedAt: "2026-01-02T00:00:00.000Z" },
      });
      await stale.upsertAccount(original);
      const fresh = await AccountStore.open({ dataDir, key });
      await fresh.updateTokens(original.email, { refreshed: true });
      await fresh.updateSettings(original.email, { style: { fontColor: "red" } });
      await stale.updateSettings(" A@EXAMPLE.COM ", { signature: "new" });

      const reopened = await AccountStore.open({ dataDir, key });
      expect(reopened.getAccount(original.email)).toMatchObject({
        ...original,
        tokens: { refreshed: true },
        signature: "new",
        style: { fontColor: "red" },
      });
    });
  });

  it("persists null settings removals and does not recreate a removed account", async () => {
    await withDataDir(async (dataDir) => {
      const stale = await AccountStore.open({ dataDir, key });
      await stale.upsertAccount(account({ signature: "old", style: { fontSize: "12px" } }));
      await stale.updateSettings("a@example.com", { signature: null, style: null });
      const fresh = await AccountStore.open({ dataDir, key });
      const cleared = fresh.getAccount("a@example.com")!;
      expect(cleared).not.toHaveProperty("signature");
      expect(cleared).not.toHaveProperty("style");
      await fresh.removeAccount("a@example.com");
      expect(await stale.updateSettings("a@example.com", { signature: "new" })).toBeUndefined();
      const reopened = await AccountStore.open({ dataDir, key });
      expect(reopened.getAccount("a@example.com")).toBeUndefined();
    });
  });

  it("preserves token and checkpoint fields across concurrent field updates", async () => {
    await withStore(async (store) => {
      await store.upsertAccount(account({
        newEmailCheckpoint: {
          receivedAt: "2026-01-01T00:00:00.000Z",
          deliveredIdsAtReceivedAt: ["old"],
        },
      }));

      await Promise.all([
        store.updateTokens("a@example.com", { refreshed: 1 }),
        store.updateNewEmailCheckpoint("a@example.com", {
          receivedAt: "2026-01-02T00:00:00.000Z",
          deliveredIdsAtReceivedAt: ["m1"],
        }),
      ]);

      const updated = store.getAccount("a@example.com");
      expect(updated?.tokens).toEqual({ refreshed: 1 });
      expect(updated?.newEmailCheckpoint).toEqual({
        receivedAt: "2026-01-02T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["m1"],
      });
    });
  });

  it("preserves checkpoints when a stale store updates tokens", async () => {
    await withDataDir(async (dataDir) => {
      const stale = await AccountStore.open({ dataDir, key });
      await stale.upsertAccount(account());
      const fresh = await AccountStore.open({ dataDir, key });

      await fresh.updateNewEmailCheckpoint("a@example.com", {
        receivedAt: "2026-01-02T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["m1"],
      });
      await stale.updateTokens("a@example.com", { refreshed: true });

      const reopened = await AccountStore.open({ dataDir, key });
      expect(reopened.getAccount("a@example.com")).toMatchObject({
        tokens: { refreshed: true },
        newEmailCheckpoint: {
          receivedAt: "2026-01-02T00:00:00.000Z",
          deliveredIdsAtReceivedAt: ["m1"],
        },
      });
    });
  });

  it("unions same-timestamp delivered IDs across stale store instances", async () => {
    await withDataDir(async (dataDir) => {
      const first = await AccountStore.open({ dataDir, key });
      await first.upsertAccount(account({
        newEmailCheckpoint: {
          receivedAt: "2026-01-01T00:00:00.000Z",
          deliveredIdsAtReceivedAt: ["a"],
        },
      }));
      const stale = await AccountStore.open({ dataDir, key });
      const fresh = await AccountStore.open({ dataDir, key });

      await fresh.updateNewEmailCheckpoint("a@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["b"],
      });
      await stale.updateNewEmailCheckpoint("a@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["c"],
      });

      const reopened = await AccountStore.open({ dataDir, key });
      expect(reopened.getAccount("a@example.com")?.newEmailCheckpoint).toEqual({
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["a", "b", "c"],
      });
    });
  });

  it("does not regress a newer checkpoint from a stale store", async () => {
    await withDataDir(async (dataDir) => {
      const first = await AccountStore.open({ dataDir, key });
      await first.upsertAccount(account({
        newEmailCheckpoint: {
          receivedAt: "2026-01-01T00:00:00.000Z",
          deliveredIdsAtReceivedAt: ["old"],
        },
      }));
      const stale = await AccountStore.open({ dataDir, key });
      const fresh = await AccountStore.open({ dataDir, key });

      await fresh.updateNewEmailCheckpoint("a@example.com", {
        receivedAt: "2026-01-03T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["new"],
      });
      await stale.updateNewEmailCheckpoint("a@example.com", {
        receivedAt: "2026-01-02T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["stale"],
      });

      const reopened = await AccountStore.open({ dataDir, key });
      expect(reopened.getAccount("a@example.com")?.newEmailCheckpoint).toEqual({
        receivedAt: "2026-01-03T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["new"],
      });
    });
  });

  it("unions delivered IDs when advancing at the same receivedAt", async () => {
    await withStore(async (store) => {
      await store.upsertAccount(account({
        newEmailCheckpoint: {
          receivedAt: "2026-01-01T00:00:00.000Z",
          deliveredIdsAtReceivedAt: ["a", "b"],
        },
      }));

      await store.updateNewEmailCheckpoint("a@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["b", "c"],
      });

      expect(store.getAccount("a@example.com")?.newEmailCheckpoint).toEqual({
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["a", "b", "c"],
      });
    });
  });

  it("replaces delivered IDs when advancing to a newer receivedAt", async () => {
    await withStore(async (store) => {
      await store.upsertAccount(account({
        newEmailCheckpoint: {
          receivedAt: "2026-01-01T00:00:00.000Z",
          deliveredIdsAtReceivedAt: ["old"],
        },
      }));

      await store.updateNewEmailCheckpoint("a@example.com", {
        receivedAt: "2026-01-02T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["new"],
      });

      expect(store.getAccount("a@example.com")?.newEmailCheckpoint).toEqual({
        receivedAt: "2026-01-02T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["new"],
      });
    });
  });

  it("does not create accounts from field updates", async () => {
    await withStore(async (store) => {
      await expect(store.updateTokens("missing@example.com", { refreshed: 1 }))
        .resolves.toBeUndefined();
      await expect(store.updateNewEmailCheckpoint("missing@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["m1"],
      })).resolves.toBeUndefined();

      expect(store.listAccounts()).toEqual([]);
    });
  });

  it("keeps upsertAccount available for account creation", async () => {
    await withStore(async (store) => {
      await store.upsertAccount(account());
      await store.updateNewEmailCheckpoint("a@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["m1"],
      });
      await store.updateTokens("a@example.com", { refreshed: true });

      expect(store.getAccount("a@example.com")).toMatchObject({
        email: "a@example.com",
        provider: "outlook",
        tokens: { refreshed: true },
        newEmailCheckpoint: {
          receivedAt: "2026-01-01T00:00:00.000Z",
          deliveredIdsAtReceivedAt: ["m1"],
        },
      });
    });
  });

  it("emits debug logs for token, checkpoint, and new-email claim writes", async () => {
    await withDataDir(async (dataDir) => {
      const lines: string[] = [];
      const logger = createLogger({ enabled: true, write: (line) => lines.push(line) });
      const store = await AccountStore.open({ dataDir, key, logger });

      await store.upsertAccount(account());
      await store.updateTokens("a@example.com", { refreshed: true });
      await store.updateNewEmailCheckpoint("a@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["m1"],
      });
      await store.claimNewEmails("a@example.com", [{
        summaryId: "m2",
        receivedAt: "2026-01-02T00:00:00.000Z",
        ids: ["m2"],
      }]);

      const events = lines.map((line) =>
        (JSON.parse(line.replace(/^\[hypermail-mcp\] debug /, "")) as { event: string }).event,
      );
      expect(events).toContain("updateTokens");
      expect(events).toContain("updateNewEmailCheckpoint");
      expect(events).toContain("claimNewEmails");
      expect(events).toContain("flush");
      expect(store.getAccount("a@example.com")?.newEmailCheckpoint).toEqual({
        receivedAt: "2026-01-02T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["m2"],
      });
    });
  });
});
