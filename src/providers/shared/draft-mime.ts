import type { ParsedMail, AddressObject } from "mailparser";
import type { SendMailOptions } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { DraftUpdateInput } from "../types.js";

export function parsedAddresses(value: AddressObject | AddressObject[] | undefined): Array<{ name: string; address: string }> {
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap((entry) => entry.value.flatMap((address) => address.address ? [{ name: address.name, address: address.address }] : address.group?.flatMap((member) => member.address ? [{ name: member.name, address: member.address }] : []) ?? []));
}

export function parsedMailOptions(parsed: ParsedMail): SendMailOptions {
  const handled = /^(from|to|cc|bcc|reply-to|subject|message-id|date|in-reply-to|references|mime-version|content-.*|dkim-signature|arc-.*)$/i;
  return {
    from: parsedAddresses(parsed.from)[0], to: parsedAddresses(parsed.to),
    cc: parsedAddresses(parsed.cc), bcc: parsedAddresses(parsed.bcc), replyTo: parsedAddresses(parsed.replyTo),
    subject: parsed.subject, messageId: parsed.messageId, date: parsed.date,
    inReplyTo: parsed.inReplyTo, references: parsed.references,
    text: parsed.text, html: parsed.html === false ? undefined : parsed.html,
    headers: parsed.headerLines.filter((header) => !handled.test(header.key)).map((header) => {
      const colon = header.line.indexOf(":");
      return { key: header.line.slice(0, colon), value: header.line.slice(colon + 1).trim() };
    }),
    attachments: parsed.attachments.map((attachment) => {
      const disposition = attachment.contentDisposition;
      if (disposition !== "inline" && disposition !== "attachment") {
        throw new Error(`unsupported attachment disposition: ${disposition} (${attachment.filename ?? "unnamed"})`);
      }
      return { filename: attachment.filename, content: attachment.content, contentType: attachment.contentType, contentDisposition: disposition, cid: attachment.cid };
    }),
  };
}

export async function buildParsedDraft(parsed: ParsedMail, update: DraftUpdateInput, attachments: ParsedMail["attachments"]): Promise<Buffer> {
  const options = parsedMailOptions({ ...parsed, attachments });
  for (const field of ["to", "cc", "bcc", "subject"] as const) {
    if (update[field] !== undefined) Object.assign(options, { [field]: update[field] });
  }
  if (update.body !== undefined) {
    options.text = update.isHtml ? undefined : update.body;
    options.html = update.isHtml ? update.body : undefined;
  }
  if (typeof options.text === "string") options.text = options.text.replace(/\r\n|\r|\n/g, "\r\n");
  if (typeof options.html === "string") options.html = options.html.replace(/\r\n|\r|\n/g, "\r\n");
  const compiled = new MailComposer(options).compile();
  compiled.keepBcc = true;
  return new Promise<Buffer>((resolve, reject) => {
    compiled.build((error: Error | null, bytes: Buffer) => error ? reject(error) : resolve(bytes));
  });
}

export function matchingAttachmentIndex(attachments: ParsedMail["attachments"], name: string | undefined, type: string | undefined, bytes: Buffer): number {
  return attachments.findIndex((attachment) => attachment.filename === name && attachment.contentType.toLowerCase() === (type ?? "application/octet-stream").toLowerCase() && attachment.content.equals(bytes));
}
