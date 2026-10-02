import type { AccountRecord } from "../../store/account-store.js";
import type { SendInput } from "../types.js";
import { ImapClient } from "./client.js";
import { decodeId } from "./helpers.js";
import { applyParsedReference } from "../shared/reference-message.js";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";


export async function buildMailOptions(
  client: ImapClient,
  account: AccountRecord,
  msg: SendInput,
  messageId?: string,
): Promise<import("nodemailer").SendMailOptions> {
  const mailOptions: import("nodemailer").SendMailOptions = {
    from: { name: account.displayName ?? "", address: account.email },
    to: msg.to.map((address) => ({ ...address, name: address.name ?? "" })),
    subject: msg.subject,
    attachDataUrls: true,
  };

  if (msg.isHtml) {
    mailOptions.html = msg.body;
  } else {
    mailOptions.text = msg.body;
  }

  if (msg.cc && msg.cc.length > 0) {
    mailOptions.cc = msg.cc.map((address) => ({ ...address, name: address.name ?? "" }));
  }
  if (msg.bcc && msg.bcc.length > 0) {
    mailOptions.bcc = msg.bcc.map((address) => ({ ...address, name: address.name ?? "" }));
  }

  if (msg.attachments && msg.attachments.length > 0) {
    mailOptions.attachments = msg.attachments.map((att) => ({
      filename: att.name,
      content: Buffer.from(att.contentBytes, "base64"),
      contentType: att.contentType,
    }));
  }

  if (messageId) {
    mailOptions.messageId = messageId;
  }

  const refId = msg.forwardMessageId || msg.inReplyTo;
  if (refId) {
    const { folder, uid } = decodeId(refId);
    const reference = await client.withMailbox(folder, async (imap) => imap.fetchOne(uid, { source: true }, { uid: true }));
    if (!reference || !reference.source) throw new Error(`reference message not found: ${refId}`);
    applyParsedReference(mailOptions, await simpleParser(Buffer.from(reference.source), { skipImageLinks: true }), msg, account.email);
  }
  return mailOptions;
}


export async function buildRawMessage(
  client: ImapClient,
  account: AccountRecord,
  msg: SendInput,
  messageId?: string,
  keepBcc = false,
): Promise<string> {
  const mailOptions = await buildMailOptions(client, account, msg, messageId);

  return new Promise<string>((resolve, reject) => {
    const mc = new MailComposer(mailOptions);
    const compiled = mc.compile();
    compiled.keepBcc = keepBcc;
    compiled.build((err: Error | null, buf: Buffer) => {
      if (err) reject(err);
      else resolve(normalizeBodyLineEndings(buf.toString("utf-8")));
    });
  });
}

export function normalizeBodyLineEndings(value: string): string;
export function normalizeBodyLineEndings(value: undefined): undefined;
export function normalizeBodyLineEndings(value: string | undefined): string | undefined;
export function normalizeBodyLineEndings(value: string | undefined): string | undefined {
  return value?.replace(/\r\n|\r|\n/g, "\r\n");
}
