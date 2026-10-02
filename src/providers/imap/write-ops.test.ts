import { Readable } from "node:stream";
import nodemailer from "nodemailer";
import type { ImapFlow } from "imapflow";
import type { SendMailOptions } from "nodemailer";
import { addAttachmentToDraft, removeAttachmentsFromDraft } from "./write-ops.js";
import { findAttachments, type BodyNode } from "./helpers.js";
import { simpleParser } from "mailparser";
import type { ParsedMail } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { describe, expect, it, vi } from "vitest";

import type { AccountRecord } from "../../store/account-store.js";
import type { ImapClientFactory } from "./client.js";
import {
  markRead,
  moveEmail,
  saveDraft,
  sendDraft,
  sendEmail,
  trashEmail,
  updateDraft,
} from "./write-ops.js";
import { IMAP_WEB_URL_UNAVAILABLE_REASON } from "./helpers.js";

const account: AccountRecord = {
  email: "user@example.com",
  provider: "imap",
  displayName: "User",
  tokens: {},
  addedAt: "2026-01-01T00:00:00.000Z",
};

function clientsFor(client: unknown): ImapClientFactory {
  return { get: () => client } as unknown as ImapClientFactory;
}

async function originalDraftSource(html = "<p>Original body</p>"): Promise<string> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const message = new MailComposer({
      from: "User <user@example.com>",
      to: "Original To <original-to@example.com>",
      cc: "Original Cc <original-cc@example.com>",
      bcc: "Original Bcc <original-bcc@example.com>",
      subject: "Original subject",
      messageId: "<original@example.com>",
      html,
      attachments: [{ filename: "original.txt", content: "original attachment" }],
    }).compile();
    message.keepBcc = true;
    message.build((err: Error | null, buf: Buffer) =>
      err ? reject(err) : resolve(buf),
    );
  });

  return raw.toString("utf-8");
}

async function textOnlyDraftSource(text: string): Promise<string> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    new MailComposer({
      from: "Original <original@example.com>",
      to: "User <user@example.com>",
      subject: "Original subject",
      text,
    }).compile().build((err: Error | null, buf: Buffer) =>
      err ? reject(err) : resolve(buf),
    );
  });

  return raw.toString("utf-8");
}

function addresses(recipients: ParsedMail["to"]): string[] {
  return (recipients ? (Array.isArray(recipients) ? recipients : [recipients]) : [])
    .flatMap(({ value }) => value)
    .map((recipient) => recipient.address ?? "");
}

function replyHistoryDraftClient(source: string, uid = 125) {
  let appendedRaw = "";
  const append = vi.fn(async (_folder, raw: string) => {
    appendedRaw = raw;
    return { uid };
  });
  const list = vi.fn(async () => []);
  const client = {
    run: vi.fn(async (fn) => fn({ append, list })),
    withMailbox: vi.fn(async (_folder, fn) =>
      fn({
        fetchOne: async () => ({
          envelope: { messageId: "<original@example.com>" },
          source,
        }),
      }),
    ),
  };

  return { client, getAppendedRaw: () => appendedRaw };
}

describe("IMAP draft write operations", () => {
  it("appends a simple draft directly to Drafts", async () => {
    const append = vi.fn(async () => ({ uid: 123 }));
    const list = vi.fn(async () => []);
    const client = {
      run: vi.fn(async (fn) => fn({ append, list })),
      withMailbox: vi.fn(),
    };

    const result = await saveDraft(clientsFor(client), account, {
      to: [{ address: "recipient@example.com" }],
      subject: "Draft subject",
      body: "<p>Hello</p>",
      isHtml: true,
      inReplyTo: false,
    });

    expect(result).toEqual({
      id: "Drafts/123",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });
    expect(client.withMailbox).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      "Drafts",
      expect.stringContaining("Draft subject"),
      ["\\Draft"],
    );
  });

  it("retries draft append without the Draft flag when flagged APPEND is rejected", async () => {
    const commandFailed = Object.assign(new Error("Command failed"), {
      responseStatus: "NO",
      responseText: "invalid flag",
    });
    const append = vi
      .fn()
      .mockRejectedValueOnce(commandFailed)
      .mockResolvedValueOnce({ uid: 124 });
    const list = vi.fn(async () => []);
    const client = {
      run: vi.fn(async (fn) => fn({ append, list })),
      withMailbox: vi.fn(),
    };

    const result = await saveDraft(clientsFor(client), account, {
      to: [{ address: "recipient@example.com" }],
      subject: "Draft subject",
      body: "<p>Hello</p>",
      isHtml: true,
      inReplyTo: false,
    });

    expect(result).toEqual({
      id: "Drafts/124",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });
    expect(append).toHaveBeenNthCalledWith(
      1,
      "Drafts",
      expect.any(String),
      ["\\Draft"],
    );
    expect(append).toHaveBeenNthCalledWith(2, "Drafts", expect.any(String));
  });

  it("includes safe IMAP response details when draft append fails", async () => {
    const commandFailed = Object.assign(new Error("Command failed"), {
      responseStatus: "NO",
      responseText: "mailbox rejected append",
      serverResponseCode: "TRYCREATE",
    });
    const append = vi.fn().mockRejectedValue(commandFailed);
    const list = vi.fn(async () => []);
    const client = {
      run: vi.fn(async (fn) => fn({ append, list })),
      withMailbox: vi.fn(),
    };

    await expect(
      saveDraft(clientsFor(client), account, {
        to: [{ address: "recipient@example.com" }],
        subject: "Secret subject should not be in error",
        body: "SECRET BODY SHOULD NOT BE IN ERROR",
        isHtml: true,
        inReplyTo: false,
      }),
    ).rejects.toThrow(
      "failed to save IMAP draft to Drafts: Command failed; responseStatus=NO; responseText=mailbox rejected append; serverResponseCode=TRYCREATE",
    );

    await expect(
      saveDraft(clientsFor(client), account, {
        to: [{ address: "recipient@example.com" }],
        subject: "Secret subject should not be in error",
        body: "SECRET BODY SHOULD NOT BE IN ERROR",
        isHtml: true,
        inReplyTo: false,
      }),
    ).rejects.not.toThrow("SECRET BODY");
  });

  it("preserves referenced message content in saved reply drafts", async () => {
    const source = await originalDraftSource(
      "<p>Clearly identifiable referenced HTML body content</p>",
    );
    const { client, getAppendedRaw } = replyHistoryDraftClient(source);

    const result = await saveDraft(clientsFor(client), account, {
      to: [{ address: "recipient@example.com" }],
      subject: "Reply draft",
      body: "<p>Composed response content</p>",
      isHtml: true,
      inReplyTo: "INBOX/9",
    });

    const draft = await simpleParser(getAppendedRaw());
    expect(result).toEqual({
      id: "Drafts/125",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });
    expect(client.withMailbox).toHaveBeenCalledWith("INBOX", expect.any(Function));
    expect(draft.inReplyTo).toBe("<original@example.com>");
    expect(draft.references).toBe("<original@example.com>");
    expect(draft.html).toContain("Composed response content");
    expect(draft.html).toContain("Clearly identifiable referenced HTML body content");
    expect(getAppendedRaw()).not.toMatch(/(?<!\r)\n|\r(?!\n)/);
  });

  it("quotes a text-only message in an empty HTML reply draft", async () => {
    const source = await textOnlyDraftSource("Identifiable referenced plain text");
    const { client, getAppendedRaw } = replyHistoryDraftClient(source, 126);

    await saveDraft(clientsFor(client), account, {
      to: [{ address: "recipient@example.com" }],
      subject: "Reply draft",
      body: "",
      isHtml: true,
      inReplyTo: "INBOX/9",
    });

    const draft = await simpleParser(getAppendedRaw());
    expect(draft.html).toContain("Identifiable referenced plain text");
  });

  it("quotes referenced content in plaintext reply drafts", async () => {
    const source = await textOnlyDraftSource("Identifiable referenced plain text");
    const { client, getAppendedRaw } = replyHistoryDraftClient(source, 127);

    await saveDraft(clientsFor(client), account, {
      to: [{ address: "recipient@example.com" }],
      subject: "Reply draft",
      body: "New plaintext response",
      isHtml: false,
      inReplyTo: "INBOX/9",
    });

    const draft = await simpleParser(getAppendedRaw());
    expect(draft.text).toContain("New plaintext response");
    expect(draft.text).toContain("Identifiable referenced plain text");
  });

  it("uses the advertised Drafts special-use mailbox", async () => {
    const append = vi.fn(async () => ({ uid: 126 }));
    const list = vi.fn(async () => [
      { path: "INBOX" },
      { path: "INBOX/Drafts", specialUse: "\\Drafts" },
    ]);
    const client = {
      run: vi.fn(async (fn) => fn({ append, list })),
      withMailbox: vi.fn(),
    };

    const result = await saveDraft(clientsFor(client), account, {
      to: [{ address: "recipient@example.com" }],
      subject: "Draft subject",
      body: "<p>Hello</p>",
      isHtml: true,
      inReplyTo: false,
    });

    expect(result).toEqual({
      id: "INBOX/Drafts/126",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });
    expect(append).toHaveBeenCalledWith(
      "INBOX/Drafts",
      expect.stringContaining("Draft subject"),
      ["\\Draft"],
    );
  });

  it("preserves recipients and attachments when updating only a draft body", async () => {
    const source = await originalDraftSource();
    let appendedRaw = "";
    const append = vi.fn(async (_folder, raw: string) => {
      appendedRaw = raw;
      return { uid: 101 };
    });
    const messageDelete = vi.fn();
    const client = {
      withMailbox: vi.fn(async (_folder, fn) =>
        fn({
          fetchOne: async () => ({
            source,
            envelope: { subject: "Original subject" },
          }),
          append,
          messageDelete,
        }),
      ),
    };

    await updateDraft(clientsFor(client), account, "Drafts/5", {
      body: "<p>Updated body</p>",
      isHtml: true,
    });

    const updated = await simpleParser(appendedRaw);
    expect(addresses(updated.to)).toEqual(["original-to@example.com"]);
    expect(addresses(updated.cc)).toEqual(["original-cc@example.com"]);
    expect(addresses(updated.bcc)).toEqual(["original-bcc@example.com"]);
    expect(updated.html).toContain("Updated body");
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]).toMatchObject({
      filename: "original.txt",
      content: Buffer.from("original attachment"),
    });
  });

  it("changes only supplied To recipients while retaining the draft body and attachments", async () => {
    const source = await originalDraftSource("<p>Original\nbody</p>");
    const parsedSource = await simpleParser(source);
    expect(parsedSource.html).toContain("\n");
    let appendedRaw = "";
    const append = vi.fn(async (_folder, raw: string) => {
      appendedRaw = raw;
      return { uid: 102 };
    });
    const client = {
      withMailbox: vi.fn(async (_folder, fn) =>
        fn({
          fetchOne: async () => ({
            source,
            envelope: { subject: "Original subject" },
          }),
          append,
          messageDelete: vi.fn(),
        }),
      ),
    };

    await updateDraft(clientsFor(client), account, "Drafts/5", {
      to: [{ address: "new-to@example.com" }],
    });

    const updated = await simpleParser(appendedRaw);
    expect(addresses(updated.to)).toEqual(["new-to@example.com"]);
    expect(updated.html).toContain("Original\nbody");
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]?.filename).toBe("original.txt");
    expect(appendedRaw).not.toMatch(/(?<!\r)\n/);
  });

  it("overrides each existing recipient field when recipients are supplied", async () => {
    const source = await originalDraftSource();
    let appendedRaw = "";
    const append = vi.fn(async (_folder, raw: string) => {
      appendedRaw = raw;
      return { uid: 103 };
    });
    const client = {
      withMailbox: vi.fn(async (_folder, fn) =>
        fn({
          fetchOne: async () => ({
            source,
            envelope: { subject: "Original subject" },
          }),
          append,
          messageDelete: vi.fn(),
        }),
      ),
    };

    await updateDraft(clientsFor(client), account, "Drafts/5", {
      to: [{ address: "replacement-to@example.com" }],
      cc: [{ address: "replacement-cc@example.com" }],
      bcc: [{ address: "replacement-bcc@example.com" }],
    });

    const updated = await simpleParser(appendedRaw);
    expect(addresses(updated.to)).toEqual(["replacement-to@example.com"]);
    expect(addresses(updated.cc)).toEqual(["replacement-cc@example.com"]);
    expect(addresses(updated.bcc)).toEqual(["replacement-bcc@example.com"]);
  });

  it("does not delete the original when the replacement draft cannot be read", async () => {
    const source = await originalDraftSource();
    const fetchOne = vi.fn(async (uid: number) => {
      if (uid === 5) {
        return { source, envelope: { subject: "Original subject" } };
      }
      return undefined;
    });
    const append = vi.fn(async () => ({ uid: 104 }));
    const messageDelete = vi.fn();
    const client = {
      withMailbox: vi.fn(async (_folder, fn) =>
        fn({ fetchOne, append, messageDelete }),
      ),
    };

    await expect(
      updateDraft(clientsFor(client), account, "Drafts/5", {
        body: "replacement body",
        isHtml: false,
      }),
    ).rejects.toThrow();

    expect(fetchOne.mock.calls.map(([uid]) => uid)).toContain(104);
    expect(messageDelete).not.toHaveBeenCalled();
  });

  it("adds the unavailable-link reason to send and draft-send results", async () => {
    const transporter = { sendMail: vi.fn(async () => ({ messageId: "<sent@example.com>" })) };
    const sendClient = {
      getTransporter: () => transporter,
      run: vi.fn(async (fn) => fn({ append: vi.fn() })),
    };
    const sent = await sendEmail(clientsFor(sendClient), account, {
      to: [{ address: "recipient@example.com" }],
      subject: "Subject",
      body: "Body",
      inReplyTo: false,
    });
    expect(sent).toEqual({
      id: "<sent@example.com>",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });

    const draftClient = {
      getTransporter: () => transporter,
      withMailbox: vi.fn(async (_folder, fn) => fn({
        fetchOne: vi.fn(async () => ({ source: "From: user@example.com\r\nTo: recipient@example.com\r\nSubject: Draft\r\n\r\nBody" })),
        messageMove: vi.fn(),
      })),
    };
    const draftSent = await sendDraft(clientsFor(draftClient), account, "Drafts/5");
    expect(draftSent).toEqual({
      id: "<sent@example.com>",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });
  });

  it("uses UIDPLUS destination IDs for moves and preserves the source ID without a map", async () => {
    const mappedMove = vi.fn(async () => ({ uidMap: new Map([[5, 42]]) }));
    const mappedClient = {
      withMailbox: vi.fn(async (_folder, fn) => fn({ messageMove: mappedMove })),
    };
    await expect(moveEmail(clientsFor(mappedClient), account, "INBOX/5", "archive")).resolves.toEqual({
      id: "Archive/42",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });

    const unmappedMove = vi.fn(async () => false);
    const unmappedClient = {
      withMailbox: vi.fn(async (_folder, fn) => fn({ messageMove: unmappedMove })),
    };
    const moved = await moveEmail(clientsFor(unmappedClient), account, "INBOX/5", "Archive");
    expect(moved).toEqual({
      id: "INBOX/5",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });
    expect(JSON.stringify(moved)).not.toContain("imap://");
  });

  it("returns unavailable-link references for trash and read-state mutations", async () => {
    const messageMove = vi.fn(async () => ({ uidMap: new Map([[5, 12]]) }));
    const trashClient = {
      run: vi.fn(async (fn) => fn({ list: vi.fn(async () => [{ path: "Deleted", specialUse: "\\Trash" }]) })),
      withMailbox: vi.fn(async (_folder, fn) => fn({ messageMove })),
    };
    await expect(trashEmail(clientsFor(trashClient), account, "INBOX/5")).resolves.toEqual({
      id: "Deleted/12",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });

    const messageFlagsAdd = vi.fn();
    const markClient = {
      withMailbox: vi.fn(async (_folder, fn) => fn({ messageFlagsAdd })),
    };
    await expect(markRead(clientsFor(markClient), account, "INBOX/5", true)).resolves.toEqual({
      id: "INBOX/5",
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    });
  });
});

async function realisticDraft(): Promise<Buffer> {
  const compiled = new MailComposer({
    from: { name: "User, Quoted", address: account.email }, to: [{ name: "To, Quoted", address: "to@example.com" }],
    cc: "cc@example.com", bcc: "secret@example.com", subject: "Original",
    messageId: "<draft@example.com>", date: new Date("2025-01-01T12:00:00Z"), references: ["<prior@example.com>"],
    text: "plain original\n--body-line", html: '<p>html original<img src="cid:image"></p>',
    headers: { "X-Custom": "retained" },
    attachments: [{ filename: "same.pdf", content: "one", contentType: "application/pdf" }, { filename: "same.pdf", content: "two", contentType: "application/pdf" }, { filename: "same.pdf", content: "two", contentType: "application/pdf" }, { filename: "café.pdf", content: "unicode", contentType: "application/pdf" }, { filename: "image.png", content: "image", contentType: "image/png", cid: "image" }],
  }).compile();
  compiled.keepBcc = true;
  return new Promise<Buffer>((resolve, reject) => {
    compiled.build((error: Error | null, bytes: Buffer) => error ? reject(error) : resolve(bytes));
  });
}

async function mailboxFake() {
  const sources = new Map<number, Buffer>([[5, await realisticDraft()]]);
  let nextUid = 10;
  const events: string[] = [];
  let failAppend = false; let failRead = false; let failDelete = false; let failSmtp = false;
  let emitted: Buffer | undefined; let envelope: { from: string | false; to: string[] } | undefined;
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const imap = {
    fetchOne: async (uid: number) => {
      const source = sources.get(uid);
      if (!source || (failRead && uid !== 5)) return false;
      const parsed = await simpleParser(source);
      return { source, bodyStructure: { type: "multipart/mixed", childNodes: parsed.attachments.map((attachment, index) => ({ part: `${index + 1}`, type: attachment.contentType, disposition: attachment.contentDisposition, dispositionParameters: { filename: attachment.filename }, parameters: attachment.cid ? { name: attachment.filename } : undefined })) } };
    },
    append: async (_folder: string, raw: string) => {
      if (failAppend) throw new Error("append failed");
      const uid = nextUid++; sources.set(uid, Buffer.from(raw)); events.push(`append:${uid}`); return { uid };
    },
    messageDelete: async (uid: number) => { if (failDelete) throw new Error("delete failed"); events.push(`delete:${uid}`); sources.delete(uid); },
    download: async (uid: number, part: string) => ({ content: Readable.from([(await simpleParser(sources.get(uid)!)).attachments[Number(part) - 1]!.content]) }),
    messageMove: async (uid: number) => { events.push(`move:${uid}`); sources.delete(uid); },
    list: async () => [],
  };
  const client = {
    withMailbox: async <T>(_folder: string, fn: (imap: ImapFlow) => Promise<T>) => fn(imap as unknown as ImapFlow),
    run: async <T>(fn: (imap: ImapFlow) => Promise<T>) => fn(imap as unknown as ImapFlow),
    getTransporter: () => ({ sendMail: async (options: SendMailOptions) => {
      if (failSmtp) throw new Error("smtp failed");
      // SMTP serializes with keepBcc=false; stream transport itself forces true.
      const compiled = new MailComposer(options).compile();
      const wire = await new Promise<Buffer>((resolve, reject) => {
        compiled.build((error: Error | null, bytes: Buffer) => error ? reject(error) : resolve(bytes));
      });
      const info = await transport.sendMail({ raw: wire, envelope: options.envelope ?? compiled.getEnvelope() });
      emitted = info.message as Buffer; envelope = info.envelope;
      return info;
    } }),
  };
  return {
    clients: clientsFor(client), sources, events,
    read: async (id: string) => simpleParser(sources.get(Number(id.split("/").at(-1)))!),
    metadata: async (id: string) => {
      const message = await imap.fetchOne(Number(id.split("/").at(-1)));
      if (!message) throw new Error(`message not readable: ${id}`);
      return findAttachments(message.bodyStructure as BodyNode);
    },
    emitted: () => emitted, envelope: () => envelope,
    setFailure: (kind: "append" | "read" | "delete" | "smtp") => { failAppend = kind === "append"; failRead = kind === "read"; failDelete = kind === "delete"; failSmtp = kind === "smtp"; },
  };
}

describe("IMAP MIME replacement and SMTP consumer behavior", () => {
  it("preserves subject-only edits and replaces alternatives only for explicit body edits", async () => {
    const state = await mailboxFake(); const before = await state.read("Drafts/5");
    const result = await updateDraft(state.clients, account, "Drafts/5", { subject: "changed" });
    const after = await state.read(result.id);
    expect(after.text).toBe(before.text); expect(after.html).toBe(before.html); expect(after.to).toEqual(before.to);
    expect(after.messageId).toBe(before.messageId); expect(after.date).toEqual(before.date); expect(after.references).toEqual(before.references);
    expect(after.attachments.map((a) => [a.filename, a.content.toString(), a.cid])).toEqual(before.attachments.map((a) => [a.filename, a.content.toString(), a.cid]));
    const replaced = await updateDraft(state.clients, account, result.id, { body: "", isHtml: false, cc: [], bcc: [] });
    const final = await state.read(replaced.id); expect(final.html).toBe(false); expect(final.text ?? "").toBe(""); expect(final.cc).toBeUndefined(); expect(final.bcc).toBeUndefined();
  });
  it("adds real listed attachment IDs and bulk-removes only selected duplicate occurrences", async () => {
    const state = await mailboxFake();
    const added = await addAttachmentToDraft(state.clients, account, "Drafts/5", "same.pdf", Buffer.from("two").toString("base64"), "application/pdf");
    expect((await state.metadata(added.id)).map((part) => part.part)).toContain(added.attachment.id);
    expect((await state.read(added.id)).attachments[Number(added.attachment.id) - 1]?.content.toString()).toBe("two");
    const selected = (await state.metadata(added.id)).filter((part) => part.name === "same.pdf").slice(0, 2).map((part) => part.part);
    const removed = await removeAttachmentsFromDraft(state.clients, account, added.id, [...selected, selected[1]!]);
    const final = await state.read(removed.id);
    expect(final.attachments.filter((a) => a.filename === "same.pdf").map((a) => a.content.toString())).toEqual(["two", "two"]);
    expect(final.attachments.find((a) => a.filename === "café.pdf")?.content.toString()).toBe("unicode");
    expect(final.text).toContain("--body-line");
    expect(state.events).toEqual(["append:10", "delete:5", "append:11", "delete:10"]);
  });
  it.each(["append", "read"] as const)("preserves original UID on %s failure", async (failure) => {
    const state = await mailboxFake();
    const selected = (await state.metadata("Drafts/5")).find((part) => part.name === "same.pdf")!.part;
    state.setFailure(failure);
    await expect(removeAttachmentsFromDraft(state.clients, account, "Drafts/5", [selected])).rejects.toThrow(failure === "append" ? "append failed" : "not readable");
    expect(state.sources.has(5)).toBe(true); expect(state.events.some((event) => event.startsWith("delete:"))).toBe(false);
  });
  it("fails an unknown attachment before APPEND and reports both UIDs if deletion fails", async () => {
    const state = await mailboxFake();
    await expect(removeAttachmentsFromDraft(state.clients, account, "Drafts/5", ["unknown"])).rejects.toThrow("attachment not found"); expect(state.events).toEqual([]);
    state.setFailure("delete");
    const selected = (await state.metadata("Drafts/5")).find((part) => part.name === "same.pdf")!.part;
    await expect(removeAttachmentsFromDraft(state.clients, account, "Drafts/5", [selected])).rejects.toThrow("replacement Drafts/10 created but original Drafts/5");
    expect(state.sources.has(5)).toBe(true); expect(state.sources.has(10)).toBe(true);
  });
  it("serializes SMTP without Bcc header while explicitly delivering To/Cc/Bcc and preserving content", async () => {
    const state = await mailboxFake(); await sendDraft(state.clients, account, "Drafts/5");
    expect(state.envelope()).toEqual({ from: account.email, to: ["to@example.com", "cc@example.com", "secret@example.com"] });
    const sent = await simpleParser(state.emitted()!); expect(sent.bcc).toBeUndefined(); expect(sent.subject).toBe("Original");
    expect(sent.text).toContain("plain original"); expect(sent.html).toContain("html original"); expect(sent.attachments.map((a) => [a.filename, a.content.toString()]).sort()).toEqual([["same.pdf", "one"], ["same.pdf", "two"], ["same.pdf", "two"], ["café.pdf", "unicode"], ["image.png", "image"]].sort());
    expect(state.events).toEqual(["move:5"]);
  });
  it("leaves draft intact on SMTP failure and rejects empty envelope", async () => {
    const state = await mailboxFake(); state.setFailure("smtp");
    await expect(sendDraft(state.clients, account, "Drafts/5")).rejects.toThrow("smtp failed"); expect(state.sources.has(5)).toBe(true); expect(state.events).toEqual([]);
    state.sources.set(5, Buffer.from("From: user@example.com\r\nSubject: no recipients\r\n\r\nbody"));
    await expect(sendDraft(state.clients, account, "Drafts/5")).rejects.toThrow("no recipients"); expect(state.sources.has(5)).toBe(true);
  });
  it("fails explicit source loads before sending/saving and quotes parsed reply/forward content", async () => {
    const state = await mailboxFake();
    const input = { to: [{ address: "explicit@example.com" }], bcc: [{ address: "requested@example.com" }], subject: "Reply", body: "<p>new</p>", isHtml: true, inReplyTo: "Drafts/5", replyAll: true };
    const reply = await saveDraft(state.clients, account, input); const parsedReply = await state.read(reply.id);
    expect(parsedReply.inReplyTo).toBe("<draft@example.com>"); expect(parsedReply.references).toEqual(["<prior@example.com>", "<draft@example.com>"]);
    expect(addresses(parsedReply.to)).toEqual(["explicit@example.com", "to@example.com"]); expect(addresses(parsedReply.cc)).toEqual(["cc@example.com"]); expect(addresses(parsedReply.bcc)).toEqual(["requested@example.com"]); expect(parsedReply.attachments.map((a) => a.filename)).toEqual(["image.png"]);
    const forward = await saveDraft(state.clients, account, { ...input, inReplyTo: false, forwardMessageId: "Drafts/5" }); const parsedForward = await state.read(forward.id);
    expect(parsedForward.html).toContain("html original"); expect(parsedForward.html).not.toContain("Content-Transfer-Encoding:"); expect(parsedForward.attachments.map((a) => [a.filename, a.content.toString()]).sort()).toEqual([["same.pdf", "one"], ["same.pdf", "two"], ["same.pdf", "two"], ["café.pdf", "unicode"], ["image.png", "image"]].sort());
    const previous = state.events.slice();
    await expect(sendEmail(state.clients, account, { ...input, inReplyTo: "Drafts/99" })).rejects.toThrow("reference message not found"); expect(state.emitted()).toBeUndefined(); expect(state.events).toEqual(previous);
  });
});

describe("IMAP direct reference sending", () => {
  it.each(["reply", "forward"] as const)("sends decoded %s content with supplied attachments", async (kind) => {
    const state = await mailboxFake();
    await sendEmail(state.clients, account, {
      to: [{ address: "explicit@example.com" }], bcc: [{ address: "requested@example.com" }],
      subject: "Composed", body: "<p>new</p>", isHtml: true, replyAll: true,
      inReplyTo: kind === "reply" ? "Drafts/5" : false,
      forwardMessageId: kind === "forward" ? "Drafts/5" : undefined,
      attachments: [{ name: "user.txt", contentBytes: Buffer.from("user supplied").toString("base64"), contentType: "text/plain" }],
    });
    const parsed = await simpleParser(state.emitted()!, { skipImageLinks: true });
    expect(parsed.html).toContain("html original"); expect(parsed.html).toContain("cid:image");
    expect(parsed.html).not.toContain("Content-Transfer-Encoding:");
    expect(parsed.attachments.find((attachment) => attachment.filename === "user.txt")?.content.toString()).toBe("user supplied");
    expect(parsed.bcc).toBeUndefined();
    expect(state.envelope()?.to).toContain("requested@example.com");
    if (kind === "reply") {
      expect(parsed.inReplyTo).toBe("<draft@example.com>");
      expect(parsed.references).toEqual(["<prior@example.com>", "<draft@example.com>"]);
      expect(addresses(parsed.to)).toEqual(["explicit@example.com", "to@example.com"]);
      expect(parsed.attachments.map((attachment) => attachment.filename)).toEqual(["image.png", "user.txt"]);
    } else {
      expect(parsed.inReplyTo).toBeUndefined();
      expect(parsed.attachments.map((attachment) => [attachment.filename, attachment.content.toString()]).sort()).toEqual([["same.pdf", "one"], ["same.pdf", "two"], ["same.pdf", "two"], ["café.pdf", "unicode"], ["image.png", "image"], ["user.txt", "user supplied"]].sort());
    }
  });
});
