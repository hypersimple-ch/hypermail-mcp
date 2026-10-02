import { readFile, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccountRecord } from "../../store/account-store.js";
import type { GmailClientFactory } from "./client.js";
import { listEmails, readAttachment, readEmail, searchEmails } from "./read-ops.js";

const downloadedPaths: string[] = [];
afterEach(async () => {
  await Promise.all(downloadedPaths.splice(0).map((path) =>
    rm(dirname(path), { recursive: true, force: true }),
  ));
});

const account: AccountRecord = {
  email: "user@example.com",
  provider: "gmail",
  tokens: {},
  addedAt: "2026-01-01T00:00:00.000Z",
};

function clientsFor(gmail: unknown): GmailClientFactory {
  return {
    get: () => ({ gmail }),
  } as unknown as GmailClientFactory;
}

describe("Gmail search", () => {
  it("preserves query-only searches", async () => {
    const list = vi.fn().mockResolvedValue({ data: {} });

    await searchEmails(
      clientsFor({ users: { messages: { list } } }),
      account,
      { query: "has:attachment" },
    );

    expect(list).toHaveBeenCalledWith({
      userId: "me",
      q: "has:attachment",
      maxResults: 25,
    });
  });

  it("builds ANDed structured filters with CC-or-BCC matching", async () => {
    const list = vi.fn().mockResolvedValue({ data: {} });

    await searchEmails(
      clientsFor({ users: { messages: { list } } }),
      account,
      {
        query: "is:unread",
        from: "sender@example.com",
        to: "recipient@example.com",
        cc: "copy@example.com",
      },
    );

    expect(list).toHaveBeenCalledWith({
      userId: "me",
      q: 'is:unread from:"sender@example.com" to:"recipient@example.com" (cc:"copy@example.com" OR bcc:"copy@example.com")',
      maxResults: 25,
    });
  });

  it("escapes structured values and forwards the requested limit", async () => {
    const list = vi.fn().mockResolvedValue({ data: {} });

    await searchEmails(
      clientsFor({ users: { messages: { list } } }),
      account,
      { from: 'a"b\\c@example.com', limit: 7 },
    );

    expect(list).toHaveBeenCalledWith({
      userId: "me",
      q: 'from:"a\\"b\\\\c@example.com"',
      maxResults: 7,
    });
  });

  it("hydrates search results with message metadata", async () => {
    const list = vi.fn().mockResolvedValue({
      data: { messages: [{ id: "message-1" }] },
    });
    const get = vi.fn().mockResolvedValue({
      data: {
        labelIds: ["INBOX"],
        internalDate: "1735689600000",
        payload: {
          headers: [
            { name: "From", value: "Sender <sender@example.com>" },
            { name: "To", value: "recipient@example.com" },
            { name: "Subject", value: "Subject" },
          ],
        },
      },
    });

    const result = await searchEmails(
      clientsFor({ users: { messages: { list, get } } }),
      account,
      { to: "recipient@example.com" },
    );

    expect(get).toHaveBeenCalledWith({
      userId: "me",
      id: "message-1",
      format: "metadata",
      metadataHeaders: ["From", "Subject", "To", "Date"],
    });
    expect(result).toEqual([
      expect.objectContaining({
        id: "message-1",
        subject: "Subject",
        from: { name: "Sender", address: "sender@example.com" },
        to: [{ address: "recipient@example.com" }],
        isRead: true,
        webUrl: "https://mail.google.com/mail/u/?authuser=user%40example.com#all/message-1",
      }),
    ]);
  });
});

describe("Gmail native web links", () => {
  const encodedAccount: AccountRecord = { ...account, email: "user+tag@example.com" };

  it("adds account-aware links to listed and full messages", async () => {
    const list = vi.fn().mockResolvedValue({ data: { messages: [{ id: "message-1" }] } });
    const get = vi.fn().mockResolvedValue({
      data: {
        labelIds: ["INBOX"],
        payload: { headers: [{ name: "Subject", value: "Subject" }] },
      },
    });
    const clients = clientsFor({ users: { messages: { list, get } } });

    const listed = await listEmails(clients, encodedAccount, { limit: 1 });
    expect(listed.items[0]?.webUrl).toBe(
      "https://mail.google.com/mail/u/?authuser=user%2Btag%40example.com#all/message-1",
    );

    const full = await readEmail(clients, encodedAccount, "message-2");
    expect(full.webUrl).toBe(
      "https://mail.google.com/mail/u/?authuser=user%2Btag%40example.com#all/message-2",
    );
  });

  it("adds the parent message link to attachment results", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        payload: {
          parts: [{
            filename: "report.txt",
            mimeType: "text/plain",
            body: { attachmentId: "attachment-1" },
          }],
        },
      },
    });
    const attachmentGet = vi.fn().mockResolvedValue({
      data: { data: Buffer.from("contents").toString("base64url") },
    });

    const result = await readAttachment(
      clientsFor({ users: { messages: { get, attachments: { get: attachmentGet } } } }),
      encodedAccount,
      "message-1",
      "attachment-1",
    );
    downloadedPaths.push(result.path);

    expect(result.webUrl).toBe(
      "https://mail.google.com/mail/u/?authuser=user%2Btag%40example.com#all/message-1",
    );
  });
});

describe("Gmail attachment download isolation", () => {
  it.each(["../../victim.pdf", "..\\victim.pdf"])("isolates %s and preserves downloaded content", async (name) => {
    const clients = clientsFor({ users: { messages: {
      get: async () => ({ data: { payload: { parts: [{
        filename: name, mimeType: "application/pdf", body: { attachmentId: "att" },
      }] } } }),
      attachments: { get: async () => ({ data: { data: Buffer.from("pdf bytes").toString("base64url") } }) },
    } } });
    const first = await readAttachment(clients, account, "message", "att");
    downloadedPaths.push(first.path);
    const second = await readAttachment(clients, account, "message", "att");
    downloadedPaths.push(second.path);
    expect(first.name).toBe(name);
    expect(first.contentType).toBe("application/pdf");
    expect(basename(first.path)).toBe("attachment.pdf");
    expect(dirname(first.path)).not.toBe(dirname(second.path));
    expect(await readFile(first.path, "utf8")).toBe("pdf bytes");
    expect(await readFile(second.path, "utf8")).toBe("pdf bytes");
  });

  it("downloads explicitly empty attachment data as a zero-byte file", async () => {
    const clients = clientsFor({ users: { messages: {
      get: async () => ({ data: {} }),
      attachments: { get: async () => ({ data: { data: "" } }) },
    } } });
    const result = await readAttachment(clients, account, "message", "empty");
    downloadedPaths.push(result.path);
    expect(await readFile(result.path)).toEqual(Buffer.alloc(0));
  });

  it.each([null, undefined])("rejects missing attachment data (%s)", async (data) => {
    const clients = clientsFor({ users: { messages: {
      get: async () => ({ data: {} }),
      attachments: { get: async () => ({ data: { data } }) },
    } } });
    await expect(readAttachment(clients, account, "message", "missing")).rejects.toThrow("attachment data is missing");
  });
});

describe("Gmail pagination", () => {
  it("keeps a remaining page discoverable and ends at the final page", async () => {
    const list = vi.fn(async ({ pageToken }: { pageToken?: string }) => ({
      data: pageToken
        ? { messages: [{ id: "second" }] }
        : { messages: [{ id: "first" }], nextPageToken: "next" },
    }));
    const get = vi.fn(async ({ id }: { id: string }) => ({
      data: { payload: { headers: [{ name: "Subject", value: id }] } },
    }));
    const clients = clientsFor({ users: { messages: { list, get } } });

    const first = await listEmails(clients, account, { limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual(["first"]);
    expect(first.hasMore).toBe(true);

    const second = await listEmails(clients, account, { limit: 1, skip: 1 });
    expect(second.items.map((item) => item.id)).toEqual(["second"]);
    expect(second.hasMore).toBe(false);
  });

  it("does not advertise another page when an exact full page has no token", async () => {
    const clients = clientsFor({ users: { messages: {
      list: async () => ({ data: { messages: [{ id: "only" }] } }),
      get: async () => ({ data: { payload: { headers: [] } } }),
    } } });
    const result = await listEmails(clients, account, { limit: 1 });
    expect(result.items.map((item) => item.id)).toEqual(["only"]);
    expect(result.hasMore).toBe(false);
  });
});
