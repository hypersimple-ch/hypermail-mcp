import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { registerNewEmailTool } from "./new-emails.js";
import { ACCOUNT_POLL_TIMEOUT_MS } from "./new-emails-timeout.js";
import { createLogger, type Logger } from "../logger.js";
import { AccountStore, type AccountRecord, type NewEmailClaimCandidate } from "../store/account-store.js";
import type { EmailFull, EmailProvider, EmailSummary, ListEmailsResult } from "../providers/types.js";
import type { Registry } from "../providers/registry.js";
import type { ResolvedTools } from "../config.js";
import type { GmailClientFactory } from "../providers/gmail/client.js";
import { listEmails as listGmailEmails } from "../providers/gmail/read-ops.js";

const tools: ResolvedTools = { enabledTools: null, disabledTools: null };

type Handler = (args: { account?: string; limit?: number }) => Promise<unknown>;

function account(email: string, checkpoint?: AccountRecord["newEmailCheckpoint"]): AccountRecord {
  return {
    email,
    provider: "imap",
    tokens: {},
    addedAt: "2026-01-01T00:00:00.000Z",
    newEmailCheckpoint: checkpoint,
  };
}

function summary(id: string, receivedAt: string, subject = id): EmailSummary {
  return { id, subject, receivedAt, folder: "inbox" };
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

function mergeCheckpoint(
  current: AccountRecord["newEmailCheckpoint"],
  incoming: AccountRecord["newEmailCheckpoint"],
): AccountRecord["newEmailCheckpoint"] {
  const currentAt = normalizeTimestamp(current?.receivedAt);
  const incomingAt = normalizeTimestamp(incoming?.receivedAt);
  if (!incomingAt) return currentAt
    ? { receivedAt: currentAt, deliveredIdsAtReceivedAt: uniqueIds(current?.deliveredIdsAtReceivedAt ?? []) }
    : undefined;
  if (!currentAt || incomingAt > currentAt) {
    return { receivedAt: incomingAt, deliveredIdsAtReceivedAt: uniqueIds(incoming?.deliveredIdsAtReceivedAt ?? []) };
  }
  if (incomingAt < currentAt) {
    return { receivedAt: currentAt, deliveredIdsAtReceivedAt: uniqueIds(current?.deliveredIdsAtReceivedAt ?? []) };
  }
  return {
    receivedAt: currentAt,
    deliveredIdsAtReceivedAt: uniqueIds([
      ...(current?.deliveredIdsAtReceivedAt ?? []),
      ...(incoming?.deliveredIdsAtReceivedAt ?? []),
    ]),
  };
}

function isDelivered(
  checkpoint: AccountRecord["newEmailCheckpoint"],
  receivedAt: string,
  ids: string[],
): boolean {
  const checkpointAt = normalizeTimestamp(checkpoint?.receivedAt);
  if (!checkpointAt) return false;
  if (receivedAt < checkpointAt) return true;
  if (receivedAt > checkpointAt) return false;
  const delivered = new Set(checkpoint?.deliveredIdsAtReceivedAt ?? []);
  return ids.some((id) => delivered.has(id));
}

function memoryStore(initial: AccountRecord[]): AccountStore {
  const records = new Map(initial.map((rec) => [rec.email, { ...rec }]));
  return {
    listAccounts: vi.fn(() => Array.from(records.values()).map((rec) => ({ ...rec }))),
    getAccount: vi.fn((email: string) => {
      const rec = records.get(email.toLowerCase());
      return rec ? { ...rec } : undefined;
    }),
    upsertAccount: vi.fn(async (rec: AccountRecord) => {
      records.set(rec.email.toLowerCase(), { ...rec });
      return { ...rec };
    }),
    updateTokens: vi.fn(async (email: string, tokens: AccountRecord["tokens"]) => {
      const rec = records.get(email.toLowerCase());
      if (!rec) return undefined;
      const next = { ...rec, tokens };
      records.set(email.toLowerCase(), next);
      return { ...next };
    }),
    updateNewEmailCheckpoint: vi.fn(async (
      email: string,
      checkpoint: NonNullable<AccountRecord["newEmailCheckpoint"]>,
    ) => {
      const rec = records.get(email.toLowerCase());
      if (!rec) return undefined;
      const merged = mergeCheckpoint(rec.newEmailCheckpoint, checkpoint);
      const next = { ...rec, newEmailCheckpoint: merged };
      records.set(email.toLowerCase(), next);
      return { ...next };
    }),
    claimNewEmails: vi.fn(async (email: string, candidates: NewEmailClaimCandidate[]) => {
      const rec = records.get(email.toLowerCase());
      if (!rec) return [];
      let checkpoint = rec.newEmailCheckpoint;
      const claimed: string[] = [];
      const ordered = [...candidates].sort((a, b) => {
        const byTimestamp = (normalizeTimestamp(a.receivedAt) ?? a.receivedAt)
          .localeCompare(normalizeTimestamp(b.receivedAt) ?? b.receivedAt);
        if (byTimestamp !== 0) return byTimestamp;
        return a.summaryId.localeCompare(b.summaryId);
      });
      for (const candidate of ordered) {
        const receivedAt = normalizeTimestamp(candidate.receivedAt);
        if (!receivedAt) continue;
        const ids = uniqueIds([candidate.summaryId, ...candidate.ids]);
        if (isDelivered(checkpoint, receivedAt, ids)) continue;
        claimed.push(candidate.summaryId);
        checkpoint = mergeCheckpoint(checkpoint, {
          receivedAt,
          deliveredIdsAtReceivedAt: ids,
        });
      }
      records.set(email.toLowerCase(), { ...rec, newEmailCheckpoint: checkpoint });
      return claimed;
    }),
  } as unknown as AccountStore;
}

function provider(
  items: EmailSummary[],
  opts: { failList?: boolean; failReadIds?: string[]; body?: string } = {},
): EmailProvider {
  return {
    id: "imap",
    listEmails: vi.fn(async (_account: AccountRecord, listOpts) => {
      if (opts.failList) throw new Error("list failed");
      const skip = listOpts.skip ?? 0;
      const limit = listOpts.limit ?? 25;
      return {
        items: items.slice(skip, skip + limit),
        hasMore: skip + limit < items.length,
      };
    }),
    readEmail: vi.fn(async (_account: AccountRecord, id: string) => {
      if (opts.failReadIds?.includes(id)) throw new Error(`read failed: ${id}`);
      const match = items.find((item) => item.id === id) ?? summary(id, "2026-01-01T00:00:00.000Z");
      return {
        ...match,
        bodyText: opts.body ?? `body ${id}`,
        attachments: [{ id: "att-1", name: "file.txt", size: 12 }],
      };
    }),
  } as unknown as EmailProvider;
}

function registry(accounts: AccountRecord[], providers: Record<string, EmailProvider>): Registry {
  const byEmail = new Map(accounts.map((rec) => [rec.email, rec]));
  return {
    resolveByEmail: vi.fn((email: string) => {
      const rec = byEmail.get(email.toLowerCase());
      if (!rec) throw new Error(`no account registered for "${email}"`);
      return { account: rec, provider: providers[rec.email] };
    }),
  } as unknown as Registry;
}

function registerHandler(store: AccountStore, reg: Registry, logger?: Logger): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: vi.fn((_name: string, _config: unknown, cb: Handler) => {
      handler = cb;
    }),
  };
  registerNewEmailTool(server as never, { store, registry: reg, tools, logger });
  if (!handler) throw new Error("handler was not registered");
  return handler;
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function currentRegistry(store: AccountStore, prov: EmailProvider): Registry {
  return {
    resolveByEmail: (email: string) => {
      const stored = store.getAccount(email);
      if (!stored) throw new Error(`no account registered for "${email}"`);
      return { account: stored, provider: prov };
    },
  } as unknown as Registry;
}

describe("get_new_emails", () => {
  it("returns an error when no accounts are registered", async () => {
    const store = memoryStore([]);
    const handler = registerHandler(store, registry([], {}));

    const result = await handler({});

    expect(result).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: "no accounts registered. Call add_account first." },
      ],
    });
  });

  it("initializes a missing checkpoint to the newest inbox timestamp", async () => {
    const acct = account("a@example.com");
    const store = memoryStore([acct]);
    const prov = provider([
      summary("newest", "2026-01-02T00:00:00.000Z"),
      summary("older", "2026-01-01T00:00:00.000Z"),
    ]);
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email }));

    expect(data).toMatchObject({ count: 0, emails: [], errors: [] });
    expect(store.updateNewEmailCheckpoint).toHaveBeenCalledWith(acct.email, {
      receivedAt: "2026-01-02T00:00:00.000Z",
      deliveredIdsAtReceivedAt: ["newest"],
    });
    expect(prov.readEmail).not.toHaveBeenCalled();
  });

  it("returns oldest unseen emails first and advances through the returned batch", async () => {
    const acct = account("a@example.com", {
      receivedAt: "2026-01-01T00:00:00.000Z",
      deliveredIdsAtReceivedAt: ["cursor"],
    });
    const store = memoryStore([acct]);
    const prov = provider([
      summary("3", "2026-01-04T00:00:00.000Z"),
      summary("2", "2026-01-03T00:00:00.000Z"),
      summary("1", "2026-01-02T00:00:00.000Z"),
      summary("cursor", "2026-01-01T00:00:00.000Z"),
    ]);
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email, limit: 2 }));

    expect((data.emails as Array<{ id: string }>).map((email) => email.id)).toEqual(["1", "2"]);
    expect(store.getAccount(acct.email)?.newEmailCheckpoint).toEqual({
      receivedAt: "2026-01-03T00:00:00.000Z",
      deliveredIdsAtReceivedAt: ["2"],
    });
  });

  it("emits debug logs for get_new_emails decisions when enabled", async () => {
    const acct = account("a@example.com", {
      receivedAt: "2026-01-01T00:00:00.000Z",
      deliveredIdsAtReceivedAt: ["cursor"],
    });
    const store = memoryStore([acct]);
    const prov = provider([
      summary("1", "2026-01-02T00:00:00.000Z"),
      summary("cursor", "2026-01-01T00:00:00.000Z"),
    ]);
    const lines: string[] = [];
    const logger = createLogger({ enabled: true, write: (line) => lines.push(line) });
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }), logger);

    const data = structured(await handler({ account: acct.email, limit: 1 }));

    expect(data.count).toBe(1);
    const events = lines.map((line) =>
      (JSON.parse(line.replace(/^\[hypermail-mcp\] debug /, "")) as { event: string }).event,
    );
    expect(events).toEqual(expect.arrayContaining([
      "start",
      "candidatesCollected",
      "selected",
      "hydrated",
      "claimed",
      "end",
    ]));
  });

  it("returns empty when no initialized-account emails are new", async () => {
    const acct = account("a@example.com", {
      receivedAt: "2026-01-02T00:00:00.000Z",
      deliveredIdsAtReceivedAt: ["newest"],
    });
    const store = memoryStore([acct]);
    const prov = provider([summary("newest", "2026-01-02T00:00:00.000Z")]);
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email }));

    expect(data).toMatchObject({ count: 0, emails: [], errors: [] });
    expect(prov.readEmail).not.toHaveBeenCalled();
    expect(store.updateNewEmailCheckpoint).not.toHaveBeenCalled();
  });

  it("defaults limit to 10", async () => {
    const acct = account("a@example.com", {
      receivedAt: "2026-01-01T00:00:00.000Z",
      deliveredIdsAtReceivedAt: [],
    });
    const store = memoryStore([acct]);
    const items = Array.from({ length: 11 }, (_, idx) =>
      summary(String(11 - idx), `2026-01-${String(12 - idx).padStart(2, "0")}T00:00:00.000Z`),
    );
    const prov = provider(items);
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email }));

    expect(data.count).toBe(10);
    expect((data.emails as Array<{ id: string }>).map((email) => email.id)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
    ]);
  });

  it("uses same-timestamp delivered IDs to drain ties without repeats", async () => {
    const acct = account("a@example.com", {
      receivedAt: "2026-01-01T00:00:00.000Z",
      deliveredIdsAtReceivedAt: ["a"],
    });
    const store = memoryStore([acct]);
    const prov = provider([
      summary("c", "2026-01-01T00:00:00.000Z"),
      summary("b", "2026-01-01T00:00:00.000Z"),
      summary("a", "2026-01-01T00:00:00.000Z"),
    ]);
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email, limit: 1 }));

    expect((data.emails as Array<{ id: string }>).map((email) => email.id)).toEqual(["b"]);
    expect(store.claimNewEmails).toHaveBeenLastCalledWith(acct.email, [{
      summaryId: "b",
      receivedAt: "2026-01-01T00:00:00.000Z",
      ids: ["b", "b"],
    }]);
    expect(store.getAccount(acct.email)?.newEmailCheckpoint?.deliveredIdsAtReceivedAt).toEqual(["a", "b"]);
  });

  it("applies all-account limit globally and reports partial errors", async () => {
    const a = account("a@example.com", { receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: [] });
    const b = account("b@example.com", { receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: [] });
    const c = account("c@example.com", { receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: [] });
    const store = memoryStore([a, b, c]);
    const providers = {
      [a.email]: provider([summary("a1", "2026-01-03T00:00:00.000Z")]),
      [b.email]: provider([summary("b1", "2026-01-02T00:00:00.000Z")]),
      [c.email]: provider([], { failList: true }),
    };
    const handler = registerHandler(store, registry([a, b, c], providers));

    const data = structured(await handler({ limit: 1 }));

    expect((data.emails as Array<{ account: string; id: string }>)).toMatchObject([
      { account: b.email, id: "b1" },
    ]);
    expect(data.errors).toEqual([{ account: c.email, message: "list failed" }]);
  });

  it("continues all-account polling and reports a timed-out account", async () => {
    vi.useFakeTimers();
    try {
      const healthy = account("healthy@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: [],
      });
      const broken = account("broken@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: [],
      });
      const store = memoryStore([healthy, broken]);
      const brokenProvider = {
        ...provider([]),
        listEmails: vi.fn(() => new Promise(() => undefined)),
      } as unknown as EmailProvider;
      const handler = registerHandler(store, registry([healthy, broken], {
        [healthy.email]: provider([summary("ok", "2026-01-02T00:00:00.000Z")]),
        [broken.email]: brokenProvider,
      }));

      const pending = handler({ limit: 2 });
      await vi.advanceTimersByTimeAsync(ACCOUNT_POLL_TIMEOUT_MS);
      const data = structured(await pending);

      expect((data.emails as Array<{ account: string; id: string }>)).toMatchObject([
        { account: healthy.email, id: "ok" },
      ]);
      expect(data.errors).toEqual([
        {
          account: broken.email,
          message: `collect new-email candidates timed out after ${ACCOUNT_POLL_TIMEOUT_MS}ms for account ${broken.email}`,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a timed-out single-account poll cleanly", async () => {
    vi.useFakeTimers();
    try {
      const acct = account("broken@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: [],
      });
      const store = memoryStore([acct]);
      const brokenProvider = {
        ...provider([]),
        listEmails: vi.fn(() => new Promise(() => undefined)),
      } as unknown as EmailProvider;
      const handler = registerHandler(store, registry([acct], { [acct.email]: brokenProvider }));

      const pending = handler({ account: acct.email });
      await vi.advanceTimersByTimeAsync(ACCOUNT_POLL_TIMEOUT_MS);
      const result = await pending;

      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: `collect new-email candidates timed out after ${ACCOUNT_POLL_TIMEOUT_MS}ms for account ${acct.email}`,
          },
        ],
      });
      expect(store.claimNewEmails).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["single", "all"] as const)("does not claim a late hydrated read after a %s-account timeout, allowing retry", async (mode) => {
    vi.useFakeTimers();
    try {
      const checkpoint = { receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: ["cursor"] };
      const acct = account("a@example.com", checkpoint);
      const store = memoryStore([acct]);
      const item = summary("pending", "2026-01-02T00:00:00.000Z");
      const prov = provider([item]);
      const lateRead = deferred<EmailFull>();
      vi.mocked(prov.readEmail).mockImplementationOnce(() => lateRead.promise);
      const handler = registerHandler(store, currentRegistry(store, prov));
      const args = mode === "single" ? { account: acct.email } : {};

      const pending = handler(args);
      await vi.advanceTimersByTimeAsync(ACCOUNT_POLL_TIMEOUT_MS + 1);
      const result = await pending;
      if (mode === "single") {
        expect(result).toMatchObject({ isError: true });
      } else {
        expect(structured(result)).toMatchObject({
          count: 0,
          errors: [{ account: acct.email, message: expect.stringContaining("hydrate new emails timed out") }],
        });
      }
      lateRead.resolve({ ...item, bodyText: "late body" });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getAccount(acct.email)?.newEmailCheckpoint).toEqual(checkpoint);
      expect(store.claimNewEmails).not.toHaveBeenCalled();
      const retry = structured(await handler(args));
      expect(retry.emails).toMatchObject([{ id: "pending", body: "body pending" }]);
      expect(store.getAccount(acct.email)?.newEmailCheckpoint).toEqual({
        receivedAt: item.receivedAt,
        deliveredIdsAtReceivedAt: ["pending"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["single", "all"] as const)("does not initialize a late baseline after a %s-account timeout", async (mode) => {
    vi.useFakeTimers();
    try {
      const acct = account("a@example.com");
      const store = memoryStore([acct]);
      const baseline = summary("baseline", "2026-01-02T00:00:00.000Z");
      const items = [baseline];
      const prov = provider(items);
      const lateList = deferred<ListEmailsResult>();
      vi.mocked(prov.listEmails).mockImplementationOnce(() => lateList.promise);
      const handler = registerHandler(store, currentRegistry(store, prov));
      const args = mode === "single" ? { account: acct.email, limit: 0 } : { limit: 0 };
      const pending = handler(args);
      await vi.advanceTimersByTimeAsync(ACCOUNT_POLL_TIMEOUT_MS + 1);
      const result = await pending;
      if (mode === "single") expect(result).toMatchObject({ isError: true });
      else expect(structured(result)).toMatchObject({
        count: 0,
        errors: [{ account: acct.email, message: expect.stringContaining("collect new-email candidates timed out") }],
      });
      lateList.resolve({ items: [baseline], hasMore: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getAccount(acct.email)?.newEmailCheckpoint).toBeUndefined();
      expect(store.updateNewEmailCheckpoint).not.toHaveBeenCalled();
      expect(structured(await handler(args))).toMatchObject({ count: 0, errors: [] });
      expect(store.getAccount(acct.email)?.newEmailCheckpoint).toEqual({
        receivedAt: baseline.receivedAt, deliveredIdsAtReceivedAt: ["baseline"],
      });
      items.unshift(summary("after-baseline", "2026-01-03T00:00:00.000Z"));
      expect(structured(await handler(mode === "single" ? { account: acct.email } : {})).emails)
        .toMatchObject([{ id: "after-baseline" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["single", "claim"], ["all", "claim"],
    ["single", "baseline"], ["all", "baseline"],
  ] as const)("awaits a %s-account durable %s blocked on the store's serial lock", async (mode, stage) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hypermail-poll-lock-"));
    const key = Buffer.alloc(32, 19);
    const releaseLock = deferred<void>();
    let lockTask: Promise<void> | undefined;
    try {
      const store = await AccountStore.open({ dataDir, key });
      const initialCheckpoint = stage === "claim" ? {
        receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: [],
      } : undefined;
      const acct = await store.upsertAccount(account("a@example.com", initialCheckpoint));
      // Hold the real per-account queue before the durable operation enters it.
      const locked = deferred<void>();
      // Test-only access to the actual serialization queue; no fake claim/store semantics.
      const serialStore = store as unknown as {
        runSerial<T>(email: string, task: () => Promise<T>): Promise<T>;
      };
      lockTask = serialStore.runSerial(acct.email, async () => {
        locked.resolve();
        await releaseLock.promise;
      });
      await locked.promise;
      const commitStarted = deferred<void>();
      if (stage === "claim") {
        const claim = store.claimNewEmails.bind(store);
        vi.spyOn(store, "claimNewEmails").mockImplementation((email, candidates) => {
          commitStarted.resolve();
          return claim(email, candidates);
        });
      } else {
        const update = store.updateNewEmailCheckpoint.bind(store);
        vi.spyOn(store, "updateNewEmailCheckpoint").mockImplementation((email, checkpoint) => {
          commitStarted.resolve();
          return update(email, checkpoint);
        });
      }
      const prov = provider([summary("pending", "2026-01-02T00:00:00.000Z")]);
      const handler = registerHandler(store, currentRegistry(store, prov));
      vi.useFakeTimers();
      let settled = false;
      const pending = handler(mode === "single" ? { account: acct.email } : {})
        .then((result) => { settled = true; return result; });
      await commitStarted.promise;
      await vi.advanceTimersByTimeAsync(ACCOUNT_POLL_TIMEOUT_MS + 1);
      expect(settled).toBe(false);
      expect(store.getAccount(acct.email)?.newEmailCheckpoint).toEqual(initialCheckpoint);
      vi.useRealTimers();
      releaseLock.resolve();
      const result = structured(await pending);
      expect(result).toMatchObject({
        emails: stage === "claim" ? [{ id: "pending" }] : [],
        errors: [],
      });
      const reopened = await AccountStore.open({ dataDir, key });
      expect(reopened.getAccount(acct.email)?.newEmailCheckpoint).toEqual({
        receivedAt: "2026-01-02T00:00:00.000Z", deliveredIdsAtReceivedAt: ["pending"],
      });
      expect(structured(await handler(mode === "single" ? { account: acct.email } : {})).emails).toEqual([]);
    } finally {
      vi.useRealTimers();
      releaseLock.resolve();
      await lockTask;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["single", "claim"], ["all", "claim"],
    ["single", "baseline"], ["all", "baseline"],
  ] as const)("reports %s-account %s persistence failures instead of returning delivery", async (mode, stage) => {
    const checkpoint = stage === "claim" ? {
      receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: [],
    } : undefined;
    const acct = account("a@example.com", checkpoint);
    const store = memoryStore([acct]);
    if (stage === "claim") vi.mocked(store.claimNewEmails).mockRejectedValueOnce(new Error("persistence failed"));
    else vi.mocked(store.updateNewEmailCheckpoint).mockRejectedValueOnce(new Error("persistence failed"));
    const prov = provider([summary("pending", "2026-01-02T00:00:00.000Z")]);
    const handler = registerHandler(store, currentRegistry(store, prov));
    const result = await handler(mode === "single" ? { account: acct.email } : {});
    if (mode === "single") expect(result).toMatchObject({
      isError: true, content: [{ type: "text", text: "persistence failed" }],
    });
    else expect(structured(result)).toMatchObject({
      emails: [], errors: [{ account: acct.email, message: "persistence failed" }],
    });
    expect(store.getAccount(acct.email)?.newEmailCheckpoint).toEqual(checkpoint);
  });

  it("discovers the oldest pending Gmail message beyond an exact full first page", async () => {
    const acct = { ...account("gmail@example.com", {
      receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: ["cursor"],
    }), provider: "gmail" as const };
    const store = memoryStore([acct]);
    const newer = Array.from({ length: 100 }, (_, index) =>
      summary(`newer-${index}`, "2026-01-03T00:00:00.000Z"));
    const items = [
      ...newer,
      summary("pending-page-two", "2026-01-02T00:00:00.000Z"),
      summary("cursor", "2026-01-01T00:00:00.000Z"),
    ];
    const gmail = {
      users: {
        messages: {
          list: vi.fn(async ({ pageToken }: { pageToken?: string }) => ({
            data: pageToken === "page-two"
              ? { messages: items.slice(100).map(({ id }) => ({ id })) }
              : {
                  messages: newer.map(({ id }) => ({ id })),
                  nextPageToken: "page-two",
                },
          })),
          get: vi.fn(async ({ id }: { id: string }) => {
            const item = items.find((entry) => entry.id === id);
            if (!item) throw new Error(`unknown fixture message: ${id}`);
            return {
              data: {
                id,
                labelIds: ["INBOX"],
                internalDate: String(Date.parse(item.receivedAt!)),
                payload: { headers: [{ name: "Subject", value: item.subject }] },
              },
            };
          }),
        },
      },
    };
    // Fake only the API boundary; use real Gmail pagination and metadata hydration.
    const clients = { get: () => ({ gmail }) } as unknown as GmailClientFactory;
    const prov: EmailProvider = {
      ...provider(items),
      id: "gmail",
      listEmails: (stored, options) => listGmailEmails(clients, stored, options),
    };
    const handler = registerHandler(store, currentRegistry(store, prov));
    expect(structured(await handler({ account: acct.email, limit: 1 })).emails)
      .toMatchObject([{ id: "pending-page-two" }]);
    expect(store.getAccount(acct.email)?.newEmailCheckpoint).toEqual({
      receivedAt: "2026-01-02T00:00:00.000Z", deliveredIdsAtReceivedAt: ["pending-page-two"],
    });
  });

  it("starts all-account candidate collection in parallel", async () => {
    const a = account("a@example.com", { receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: [] });
    const b = account("b@example.com", { receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: [] });
    const store = memoryStore([a, b]);
    const started: string[] = [];
    let resolveBothStarted!: () => void;
    let releaseLists!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const listsReleased = new Promise<void>((resolve) => {
      releaseLists = resolve;
    });
    const blockingProvider = (acct: AccountRecord, items: EmailSummary[]): EmailProvider => ({
      ...provider(items),
      listEmails: vi.fn(async (_account: AccountRecord, listOpts) => {
        started.push(acct.email);
        if (started.length === 2) resolveBothStarted();
        await listsReleased;
        const skip = listOpts.skip ?? 0;
        const limit = listOpts.limit ?? 25;
        return {
          items: items.slice(skip, skip + limit),
          hasMore: skip + limit < items.length,
        };
      }),
    } as unknown as EmailProvider);
    const providers = {
      [a.email]: blockingProvider(a, [summary("a1", "2026-01-02T00:00:00.000Z")]),
      [b.email]: blockingProvider(b, [summary("b1", "2026-01-03T00:00:00.000Z")]),
    };
    const handler = registerHandler(store, registry([a, b], providers));

    const pending = handler({ limit: 2 });
    const parallelStarted = await Promise.race([
      bothStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseLists();
    const data = structured(await pending);

    expect(parallelStarted).toBe(true);
    expect(started).toEqual(expect.arrayContaining([a.email, b.email]));
    expect((data.emails as Array<{ id: string }>).map((email) => email.id)).toEqual(["a1", "b1"]);
  });

  it("fails a single-account call and does not advance when a selected read fails", async () => {
    const checkpoint = { receivedAt: "2026-01-01T00:00:00.000Z", deliveredIdsAtReceivedAt: [] };
    const acct = account("a@example.com", checkpoint);
    const store = memoryStore([acct]);
    const prov = provider([summary("1", "2026-01-02T00:00:00.000Z")], { failReadIds: ["1"] });
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }));

    const result = await handler({ account: acct.email });

    expect(result).toMatchObject({ isError: true });
    expect(store.claimNewEmails).not.toHaveBeenCalled();
  });

  it("supports limit 0 without reading or advancing initialized accounts", async () => {
    const acct = account("a@example.com", {
      receivedAt: "2026-01-01T00:00:00.000Z",
      deliveredIdsAtReceivedAt: [],
    });
    const store = memoryStore([acct]);
    const prov = provider([summary("1", "2026-01-02T00:00:00.000Z")]);
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email, limit: 0 }));

    expect(data).toMatchObject({ count: 0, emails: [], errors: [] });
    expect(prov.readEmail).not.toHaveBeenCalled();
    expect(store.updateNewEmailCheckpoint).not.toHaveBeenCalled();
  });

  it("claims concurrent hydrated candidates only once across store instances", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hypermail-new-emails-"));
    try {
      const base = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 7) });
      const acct = await base.upsertAccount(account("a@example.com", {
        receivedAt: "2026-01-01T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["cursor"],
      }));
      const items = [
        summary("new", "2026-01-02T00:00:00.000Z"),
        summary("cursor", "2026-01-01T00:00:00.000Z"),
      ];

      let readCount = 0;
      let releaseReads!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      const blockedProvider = (): EmailProvider => ({
        id: "imap",
        listEmails: vi.fn(async (_account: AccountRecord, listOpts) => {
          const skip = listOpts.skip ?? 0;
          const limit = listOpts.limit ?? 25;
          return {
            items: items.slice(skip, skip + limit),
            hasMore: skip + limit < items.length,
          };
        }),
        readEmail: vi.fn(async (_account: AccountRecord, id: string) => {
          readCount += 1;
          if (readCount === 2) releaseReads();
          await bothRead;
          const match = items.find((item) => item.id === id)!;
          return { ...match, bodyText: `body ${id}` };
        }),
      } as unknown as EmailProvider);

      const storeA = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 7) });
      const storeB = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 7) });
      const registryFor = (store: AccountStore, prov: EmailProvider): Registry => ({
        get: vi.fn(() => prov),
        resolveByEmail: vi.fn((email: string) => {
          const stored = store.getAccount(email);
          if (!stored) throw new Error(`no account registered for "${email}"`);
          return { account: stored, provider: prov };
        }),
        list: vi.fn(() => [prov]),
      } as unknown as Registry);
      const handlerA = registerHandler(storeA, registryFor(storeA, blockedProvider()));
      const handlerB = registerHandler(storeB, registryFor(storeB, blockedProvider()));

      const [first, second] = await Promise.all([
        handlerA({ account: acct.email, limit: 1 }),
        handlerB({ account: acct.email, limit: 1 }),
      ]);
      const delivered = [
        ...((structured(first).emails as Array<{ id: string }>).map((email) => email.id)),
        ...((structured(second).emails as Array<{ id: string }>).map((email) => email.id)),
      ];

      expect(delivered).toEqual(["new"]);
      expect([structured(first).count, structured(second).count].sort()).toEqual([0, 1]);
      const reopened = await AccountStore.open({ dataDir, key: Buffer.alloc(32, 7) });
      expect(reopened.getAccount(acct.email)?.newEmailCheckpoint).toEqual({
        receivedAt: "2026-01-02T00:00:00.000Z",
        deliveredIdsAtReceivedAt: ["new"],
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("returns markdown bodies with truncation metadata and attachment metadata only", async () => {
    const acct = account("a@example.com", {
      receivedAt: "2026-01-01T00:00:00.000Z",
      deliveredIdsAtReceivedAt: [],
    });
    const store = memoryStore([acct]);
    const prov = provider([
      { ...summary("1", "2026-01-02T00:00:00.000Z"), hasAttachments: true },
    ], { body: "x".repeat(20_001) });
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email }));
    const email = (data.emails as Array<Record<string, unknown>>)[0]!;

    expect(email.bodyFormat).toBe("markdown");
    expect((email.body as string).length).toBe(20_000);
    expect(email.bodyTruncated).toBe(true);
    expect(email.bodyOriginalLength).toBe(20_001);
    expect(email.attachments).toEqual([{ id: "att-1", name: "file.txt", size: 12 }]);
  });

  it("copies each hydrated email's native link or unavailable reason into the batch", async () => {
    const acct = account("a@example.com", {
      receivedAt: "2026-01-01T00:00:00.000Z",
      deliveredIdsAtReceivedAt: [],
    });
    const store = memoryStore([acct]);
    const prov = provider([
      {
        ...summary("linked", "2026-01-03T00:00:00.000Z"),
        webUrl: "https://outlook.office.com/mail/linked",
      },
      {
        ...summary("imap", "2026-01-02T00:00:00.000Z"),
        webUrlUnavailableReason: "IMAP does not expose native web links.",
      },
    ]);
    const handler = registerHandler(store, registry([acct], { [acct.email]: prov }));

    const data = structured(await handler({ account: acct.email }));

    expect(data.emails).toMatchObject([
      {
        id: "imap",
        webUrlUnavailableReason: "IMAP does not expose native web links.",
      },
      { id: "linked", webUrl: "https://outlook.office.com/mail/linked" },
    ]);
  });
});
