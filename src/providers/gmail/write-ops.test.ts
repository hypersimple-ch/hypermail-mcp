import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { GmailClientFactory } from "./client.js";
import type { AccountRecord } from "../../store/account-store.js";
import { addAttachmentToDraft, removeAttachmentsFromDraft, saveDraft, sendDraft, sendEmail, updateDraft } from "./write-ops.js";

const account: AccountRecord = { email: "user@example.com", provider: "gmail", tokens: {}, addedAt: "2026-01-01" };
async function fixture() {
  const compiled = new MailComposer({ from: { name: "Sender, Quoted", address: "sender@example.com" }, to: [{ name: "Recipient, Quoted", address: "to@example.com" }], cc: "cc@example.com", bcc: "secret@example.com", subject: "Original", text: "plain original\n--body-line", html: '<p>html original<img src="cid:image"></p>', date: new Date("2025-01-01T12:00:00Z"), messageId: "<original@example.com>", references: ["<ancestor@example.com>"], headers: { "X-Custom": "retained", "DKIM-Signature": "invalid" }, attachments: [{ filename: "same.pdf", content: Buffer.from("one"), contentType: "application/pdf" }, { filename: "same.pdf", content: Buffer.from("two"), contentType: "application/pdf" }, { filename: "same.pdf", content: Buffer.from("two"), contentType: "application/pdf" }, { filename: "café.pdf", content: Buffer.from("unicode"), contentType: "application/pdf" }, { filename: "image.png", content: Buffer.from("image"), contentType: "image/png", cid: "image" }] }).compile();
  compiled.keepBcc = true;
  return new Promise<Buffer>((resolve, reject) => {
    compiled.build((error: Error | null, bytes: Buffer) => error ? reject(error) : resolve(bytes));
  });
}
async function fake(source?: Buffer) {
  const initial = source ?? await fixture();
  let raw = initial; let id = "message-0"; let sequence = 0; let writes = 0; let sent: Buffer | undefined; let thread: string | undefined;
  const requireMessage = (given: string) => { if (given !== id) throw new Error("wrong message resource"); };
  const requireDraft = (given: string) => { if (given !== "draft-container") throw new Error("wrong draft resource"); };
  const representation = async () => { const parsed = await simpleParser(raw); return { id, payload: { parts: parsed.attachments.map((attachment, index) => ({ filename: attachment.filename, mimeType: attachment.contentType, body: { attachmentId: `${id}-attachment-${index}` } })) } }; };
  const gmail = { users: { drafts: {
    list: async ({ pageToken }: { pageToken?: string }) => ({ data: pageToken ? { drafts: [{ id: "draft-container", message: { id } }] } : { drafts: [], nextPageToken: "second" } }),
    get: async ({ id: given }: { id: string }) => { requireDraft(given); return { data: { message: { id, raw: raw.toString("base64url"), threadId: "thread" } } }; },
    create: async ({ requestBody }: { requestBody: { message: { raw: string; threadId?: string } } }) => { raw = Buffer.from(requestBody.message.raw, "base64url"); id = `message-${++sequence}`; writes++; thread = requestBody.message.threadId; return { data: { id: "draft-container", message: { id } } }; },
    update: async ({ id: given, requestBody }: { id: string; requestBody: { message: { raw: string } } }) => { requireDraft(given); raw = Buffer.from(requestBody.message.raw, "base64url"); id = `message-${++sequence}`; writes++; return { data: { id: "draft-container", message: { id } } }; },
    send: async ({ requestBody }: { requestBody: { id: string } }) => { requireDraft(requestBody.id); sent = raw; return { data: { id: "sent-message" } }; },
  }, messages: {
    get: async ({ id: given, format }: { id: string; format: string }) => { if (given === "reference") return { data: { raw: initial.toString("base64url"), threadId: "source-thread" } }; requireMessage(given); return { data: format === "raw" ? { id, raw: raw.toString("base64url") } : await representation() }; },
    attachments: { get: async ({ messageId, id: attachmentId }: { messageId: string; id: string }) => { requireMessage(messageId); const index = Number(attachmentId.split("-attachment-")[1]); const parsed = await simpleParser(raw); if (!attachmentId.startsWith(`${id}-attachment-`) || !parsed.attachments[index]) throw new Error("missing attachment"); return { data: { data: parsed.attachments[index].content.toString("base64url") } }; } },
    send: async ({ requestBody }: { requestBody: { raw: string; threadId?: string } }): Promise<{ data: { id?: string } }> => { sent = Buffer.from(requestBody.raw, "base64url"); thread = requestBody.threadId; return { data: { id: "sent-message" } }; },
  } } };
  return { clients: { get: () => ({ gmail }) } as unknown as GmailClientFactory, gmail, read: async () => simpleParser(raw), metadata: representation, current: () => id, writes: () => writes, sent: () => sent, thread: () => thread };
}
const input = { to: [{ address: "explicit@example.com" }], bcc: [{ address: "requested-bcc@example.com" }], subject: "New", body: "new body", inReplyTo: false as const };

describe("Gmail message-ID draft contract and parsed MIME", () => {
  it("uses returned IDs throughout create/read/edit/add/bulk-remove/read/send", async () => {
    const state = await fake();
    const created = await saveDraft(state.clients, account, { ...input, attachments: [{ name: "old.pdf", contentBytes: Buffer.from("old").toString("base64"), contentType: "application/pdf" }] });
    expect((await state.metadata()).id).toBe(created.id);
    const createdMail = await state.read();
    expect((Array.isArray(createdMail.bcc) ? createdMail.bcc.flatMap((addresses) => addresses.value) : createdMail.bcc?.value ?? []).map((address) => address.address)).toEqual(["requested-bcc@example.com"]);
    const edited = await updateDraft(state.clients, account, created.id, { subject: "Edited" });
    const added = await addAttachmentToDraft(state.clients, account, edited.id, "new.pdf", Buffer.from("new").toString("base64"), "application/pdf");
    expect((await state.metadata()).payload.parts.map((part) => part.body.attachmentId)).toContain(added.attachment.id);
    const oldId = (await state.metadata()).payload.parts.find((part) => part.filename === "old.pdf")!.body.attachmentId;
    const removed = await removeAttachmentsFromDraft(state.clients, account, added.id, [oldId]);
    expect((await state.metadata()).id).toBe(removed.id);
    expect((await state.read()).attachments.map((attachment) => attachment.filename)).toEqual(["new.pdf"]);
    expect((await sendDraft(state.clients, account, removed.id)).id).toBe("sent-message");
    expect((await simpleParser(state.sent()!)).subject).toBe("Edited");
  });
  it("preserves alternatives, structured recipients, bytes, threading, dates and custom headers on subject-only edits", async () => {
    const state = await fake(); const before = await state.read();
    await updateDraft(state.clients, account, state.current(), { subject: "changed" });
    const after = await state.read();
    expect(after.text).toBe(before.text); expect(after.html).toBe(before.html);
    expect(after.to).toEqual(before.to); expect(after.bcc).toEqual(before.bcc);
    expect(after.messageId).toBe(before.messageId); expect(after.date).toEqual(before.date); expect(after.references).toEqual(before.references);
    expect(after.headers.get("x-custom")).toBe("retained"); expect(after.headers.has("dkim-signature")).toBe(false);
    expect(after.attachments.map((a) => [a.filename, a.content.toString(), a.cid])).toEqual(before.attachments.map((a) => [a.filename, a.content.toString(), a.cid]));
    await updateDraft(state.clients, account, state.current(), { body: "", isHtml: false, cc: [], bcc: [] });
    const replaced = await state.read(); expect(replaced.html).toBe(false); expect(replaced.text ?? "").toBe(""); expect(replaced.cc).toBeUndefined(); expect(replaced.bcc).toBeUndefined();
  });
  it("maps duplicate attachments by bytes and consumes one identical occurrence per provider ID", async () => {
    const state = await fake(); const parts = (await state.metadata()).payload.parts.filter((part) => part.filename === "same.pdf");
    await removeAttachmentsFromDraft(state.clients, account, state.current(), [parts[0]!.body.attachmentId, parts[1]!.body.attachmentId, parts[1]!.body.attachmentId]);
    expect((await state.read()).attachments.filter((a) => a.filename === "same.pdf").map((a) => a.content.toString())).toEqual(["two"]);
    expect((await state.read()).text).toContain("--body-line");
  });
  it("fails unknown attachment and missing draft identity without mutation", async () => {
    const state = await fake(); await expect(removeAttachmentsFromDraft(state.clients, account, state.current(), ["unknown"])).rejects.toThrow("attachment not found");
    await expect(updateDraft(state.clients, account, "draft-container", { subject: "bad" })).rejects.toThrow("draft not found"); expect(state.writes()).toBe(0);
  });
  it("preserves requested Bcc in direct-send MIME and fails missing response IDs", async () => {
    const state = await fake(); await sendEmail(state.clients, account, input);
    const sent = await simpleParser(state.sent()!);
    const bcc = Array.isArray(sent.bcc) ? sent.bcc.flatMap((addresses) => addresses.value) : sent.bcc?.value ?? [];
    expect(bcc.map((address) => address.address)).toEqual(["requested-bcc@example.com"]);
    state.gmail.users.messages.send = async () => ({ data: {} });
    await expect(sendEmail(state.clients, account, input)).rejects.toThrow("no message ID");
  });
  it("replies carry RFC history and replyAll deduplication; forwards are decoded and unthreaded on send and save", async () => {
    for (const action of [sendEmail, saveDraft]) {
      const state = await fake();
      await action(state.clients, account, { ...input, inReplyTo: "reference", replyAll: true, isHtml: true });
      const reply = action === sendEmail ? await simpleParser(state.sent()!) : await state.read();
      expect(reply.inReplyTo).toBe("<original@example.com>"); expect(reply.references).toEqual(["<ancestor@example.com>", "<original@example.com>"]);
      expect(reply.to && !Array.isArray(reply.to) ? reply.to.value.map((a) => a.address) : []).toEqual(["explicit@example.com", "sender@example.com", "to@example.com"]);
      expect((Array.isArray(reply.bcc) ? reply.bcc.flatMap((addresses) => addresses.value) : reply.bcc?.value ?? []).map((address) => address.address)).toEqual(["requested-bcc@example.com"]);
      expect(reply.attachments.map((a) => a.filename)).toEqual(["image.png"]); expect(state.thread()).toBe("source-thread");
      await action(state.clients, account, { ...input, forwardMessageId: "reference", isHtml: true });
      const forward = action === sendEmail ? await simpleParser(state.sent()!) : await state.read();
      expect(forward.html).toContain("html original"); expect(forward.html).not.toContain("Content-Transfer-Encoding:"); expect(forward.attachments).toHaveLength(5); expect(state.thread()).toBeUndefined();
    }
  });
});

describe("Gmail reference failures and supplied attachments", () => {
  it("fails missing RFC Message-ID before any send or draft creation", async () => {
    const state = await fake(Buffer.from("From: sender@example.com\r\nTo: user@example.com\r\nSubject: source\r\n\r\noriginal"));
    for (const action of [sendEmail, saveDraft]) {
      await expect(action(state.clients, account, { ...input, inReplyTo: "reference" })).rejects.toThrow("missing RFC Message-ID");
    }
    expect(state.sent()).toBeUndefined(); expect(state.writes()).toBe(0);
  });
  it("retains inherited CID references and user attachments when forwarding and replying", async () => {
    const state = await fake();
    for (const message of [{ ...input, inReplyTo: "reference" }, { ...input, forwardMessageId: "reference" }]) {
      await sendEmail(state.clients, account, { ...message, isHtml: true, attachments: [{ name: "user.txt", contentBytes: Buffer.from("user supplied").toString("base64"), contentType: "text/plain" }] });
      const parsed = await simpleParser(state.sent()!, { skipImageLinks: true });
      expect(parsed.html).toContain("cid:image");
      expect(parsed.attachments.find((attachment) => attachment.filename === "user.txt")?.content.toString()).toBe("user supplied");
      expect(parsed.attachments.find((attachment) => attachment.cid === "image")?.content.toString()).toBe("image");
    }
  });
  it("propagates explicit reference load failures without sending or saving", async () => {
    const state = await fake();
    state.gmail.users.messages.get = async () => { throw new Error("reference unavailable"); };
    for (const action of [sendEmail, saveDraft]) await expect(action(state.clients, account, { ...input, forwardMessageId: "reference" })).rejects.toThrow("reference unavailable");
    expect(state.sent()).toBeUndefined(); expect(state.writes()).toBe(0);
  });
  it("refuses an unmatchable MIME part before rewriting", async () => {
    const state = await fake();
    const attachmentId = (await state.metadata()).payload.parts[0]!.body.attachmentId;
    state.gmail.users.messages.attachments.get = async () => ({ data: { data: Buffer.from("wrong bytes").toString("base64url") } });
    await expect(removeAttachmentsFromDraft(state.clients, account, state.current(), [attachmentId])).rejects.toThrow(`cannot map attachment MIME part: ${attachmentId}`);
    expect(state.writes()).toBe(0);
  });
});

describe("draft reconstruction validation", () => {
  it("rejects unsupported attachment dispositions before provider mutation", async () => {
    const source = Buffer.from("From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: original\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=parts\r\n\r\n--parts\r\nContent-Type: text/plain\r\n\r\nbody\r\n--parts\r\nContent-Type: application/pdf; name=file.pdf\r\nContent-Disposition: form-data; filename=file.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nYnl0ZXM=\r\n--parts--\r\n");
    const state = await fake(source);
    await expect(updateDraft(state.clients, account, state.current(), { subject: "changed" })).rejects.toThrow("unsupported attachment disposition: form-data");
    expect(state.writes()).toBe(0);
    expect((await state.read()).subject).toBe("original");
  });
});
