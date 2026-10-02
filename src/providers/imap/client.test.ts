import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const imapFlowMock = vi.hoisted(() => ({
  connectError: undefined as unknown,
  connectGate: undefined as Promise<void> | undefined,
  instances: [] as Array<{
    options: Record<string, unknown>;
    connect: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  } & EventEmitter>,
}));

vi.mock("imapflow", async () => {
  // Vitest hoists this factory before static imports; load the fake's base class here.
  const { EventEmitter } = await import("node:events");
  return {
    ImapFlow: class MockImapFlow extends EventEmitter {
      options: Record<string, unknown>;
      connect = vi.fn(async () => {
        await imapFlowMock.connectGate;
        if (imapFlowMock.connectError) throw imapFlowMock.connectError;
      });
      logout = vi.fn(async () => undefined);

      constructor(options: Record<string, unknown>) {
        super();
        this.options = options;
        imapFlowMock.instances.push(this);
      }
    },
  };
});

import {
  IMAP_OPERATION_TIMEOUT_MS,
  ImapClient,
} from "./client.js";

beforeEach(() => {
  imapFlowMock.connectError = undefined;
  imapFlowMock.connectGate = undefined;
  imapFlowMock.instances.length = 0;
  vi.useRealTimers();
});

describe("ImapClient timeouts", () => {

  it("reports post-TLS authentication failures with remediation guidance", async () => {
    imapFlowMock.connectError = Object.assign(new Error("Unexpected close"), {
      authenticationFailed: true,
      error: { code: "ClosedAfterConnectTLS" },
      code: "NoConnection",
    });
    const client = new ImapClient(tokens());

    await expect(client.getImap()).rejects.toThrow(
      "IMAP authentication failed for account user@example.com (imap.example.com:993). Verify the password/app-password and IMAP access policy, then re-add or update the account. Provider error code: ClosedAfterConnectTLS.",
    );
  });

  it("does not classify unrelated connect errors as authentication failures", async () => {
    imapFlowMock.connectError = Object.assign(new Error("ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const client = new ImapClient(tokens());

    await expect(client.getImap()).rejects.toThrow("ECONNREFUSED");
    await expect(client.getImap()).rejects.not.toThrow("password/app-password");
  });

  it("rejects timed-out operations and resets the queue for the next call", async () => {
    vi.useFakeTimers();
    const client = new ImapClient(tokens());
    const logout = vi.fn(async () => undefined);
    (client as unknown as { imap: unknown }).imap = { logout };

    const pending = client.run(() => new Promise(() => undefined));
    const assertion = expect(pending).rejects.toThrow("IMAP operation timed out");
    await vi.advanceTimersByTimeAsync(IMAP_OPERATION_TIMEOUT_MS);

    await assertion;
    expect(logout).toHaveBeenCalledTimes(1);
    await expect(client.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("ImapClient operation serialization", () => {
  it("runs direct IMAP operations sequentially", async () => {
    const client = new ImapClient(tokens());
    (client as unknown as { imap: unknown }).imap = {};

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = client.run(async () => {
      order.push("first-start");
      await firstMayFinish;
      order.push("first-end");
    });
    const second = client.run(async () => {
      order.push("second-start");
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first-start"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("serializes mailbox operations and releases locks", async () => {
    const client = new ImapClient(tokens());
    const releases: string[] = [];
    (client as unknown as { imap: unknown }).imap = {
      getMailboxLock: async (mailbox: string) => ({
        release: () => releases.push(mailbox),
      }),
    };

    await client.withMailbox("INBOX", async () => "ok");

    expect(releases).toEqual(["INBOX"]);
  });
});

describe("ImapClient connection lifecycle", () => {
  // Executor gates keep these regressions runnable on the supported Node 20 runtime.
  it("does not expose the initial connection until all concurrent callers are ready", async () => {
    let release!: () => void;
    imapFlowMock.connectGate = new Promise<void>((resolve) => { release = resolve; });
    const client = new ImapClient(tokens());
    const received: unknown[] = [];
    const first = client.getImap().then((imap) => { received.push(imap); return imap; });
    const second = client.getImap().then((imap) => { received.push(imap); return imap; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([]);
    release();
    const connections = await Promise.all([first, second]);
    expect(connections).toEqual([imapFlowMock.instances[0], imapFlowMock.instances[0]]);
    expect(imapFlowMock.instances).toHaveLength(1);
    await client.disconnect();
  });

  it.each(["close", "error"])("reconnects after idle %s without logging provider secrets", async (event) => {
    const debug = vi.fn();
    const client = new ImapClient(tokens(), {
      logger: { debug } as never,
    });
    const old = await client.getImap();
    imapFlowMock.instances[0]!.emit(event, new Error("secret provider command"));
    const current = await client.run(async (imap) => imap);
    expect(current).not.toBe(old);
    expect(current).toBe(imapFlowMock.instances[1]);
    expect(JSON.stringify(debug.mock.calls)).not.toContain("secret provider command");
    expect(imapFlowMock.instances[0]!.logout).not.toHaveBeenCalled();
    // A delayed old event must not evict the new cached connection.
    imapFlowMock.instances[0]!.emit("close");
    imapFlowMock.instances[0]!.emit("error", new Error("late old error"));
    expect(await client.getImap()).toBe(current);
    await client.disconnect();
  });

  it("does not let an old connect failure evict a replacement connection", async () => {
    let rejectOld!: (err: Error) => void;
    imapFlowMock.connectGate = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    const client = new ImapClient(tokens());
    const old = client.getImap();
    const assertion = expect(old).rejects.toThrow("old failed");
    imapFlowMock.instances[0]!.emit("close");
    imapFlowMock.connectGate = undefined;
    const current = await client.getImap();
    rejectOld(new Error("old failed"));
    await assertion;
    expect(await client.getImap()).toBe(current);
    await client.disconnect();
  });

  it("does not replay a failed mutation after a connection error", async () => {
    const client = new ImapClient(tokens());
    const mutation = vi.fn(async () => {
      imapFlowMock.instances[0]!.emit("error", new Error("connection lost"));
      throw new Error("mutation outcome unknown");
    });
    await expect(client.run(mutation)).rejects.toThrow("mutation outcome unknown");
    expect(await client.run(async (imap) => imap)).toBe(imapFlowMock.instances[1]);
    expect(mutation).toHaveBeenCalledTimes(1);
    await client.disconnect();
  });

  it("detaches a disconnecting connection before logout completes", async () => {
    const client = new ImapClient(tokens());
    await client.getImap();
    const old = imapFlowMock.instances[0]!;
    let release!: () => void;
    old.logout.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const disconnecting = client.disconnect();
    const current = await client.getImap();
    old.emit("close");
    release();
    await disconnecting;
    expect(await client.getImap()).toBe(current);
    await client.disconnect();
  });
});

function tokens() {
  return {
    host: "imap.example.com",
    port: 993,
    secure: true,
    user: "user@example.com",
    password: "secret",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSecure: false,
  };
}
