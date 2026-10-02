import type { ParsedMail } from "mailparser";
import type { SendMailOptions } from "nodemailer";
import { applyParsedReference } from "../shared/reference-message.js";
import type { gmail_v1 } from "googleapis";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

import { parseInlineImages } from "../shared/inline-images.js";

import type { AccountRecord } from "../../store/account-store.js";
import type {
  AttachmentContent,
  EmailAddress,
  EmailFull,
  EmailSummary,
  FolderInfo,
  EmailWebLinkFields,
  SendInput,
} from "../types.js";

// ── well-known folder ↔ Gmail label mapping ──

/** Map a well-known folder name to its Gmail system-label id. */
const WELL_KNOWN_TO_LABEL: Record<string, string> = {
  inbox: "INBOX",
  sentitems: "SENT",
  drafts: "DRAFT",
  deleteditems: "TRASH",
  junkemail: "SPAM",
  outbox: "", // Gmail has no outbox; sendEmail handles this.
};

export function resolveLabel(wellKnownOrId: string): string {
  const lower = wellKnownOrId.toLowerCase();
  return WELL_KNOWN_TO_LABEL[lower] ?? wellKnownOrId;
}

/**
 * For "archive" we must *remove* the INBOX label rather than add a
 * destination. Other well-known names map normally.
 */
export function resolveLabelsForMove(
  destinationId: string,
): { addLabelIds: string[]; removeLabelIds: string[] } {
  if (destinationId.toLowerCase() === "archive") {
    return { addLabelIds: [], removeLabelIds: ["INBOX"] };
  }
  return { addLabelIds: [resolveLabel(destinationId)], removeLabelIds: [] };
}

// ── map Gmail API responses to shared types ──

export interface GmailMessageListEntry {
  id?: string | null;
  threadId?: string | null;
}

export function mapHeaderAddr(
  raw: string | null | undefined,
): EmailAddress[] {
  if (!raw) return [];
  const addrs = raw.split(",");
  return addrs.map((a) => {
    const trimmed = a.trim();
    const match = trimmed.match(/^(.+?)\s*<(.+@.+)>$/);
    if (match) return { name: match[1]!.trim(), address: match[2]! };
    return { address: trimmed };
  });
}

type GmailMessage = gmail_v1.Schema$Message;
type GmailMessagePart = gmail_v1.Schema$MessagePart;

export function findHeader(
  headers: GmailMessagePart["headers"],
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const h = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? undefined;
}

/** Decode Gmail's base64url-encoded body part into a UTF-8 string. */
export function decodeBody(body: gmail_v1.Schema$MessagePartBody): string {
  if (!body?.data) return "";
  return Buffer.from(
    body.data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf-8");
}

interface ParsedPayload {
  bodyText?: string;
  bodyHtml?: string;
  attachments: NonNullable<EmailFull["attachments"]>;
}

/** Walk the MIME part tree to extract text, HTML, and attachments. */
export function parsePayload(
  payload: GmailMessagePart,
  prefix = "",
): ParsedPayload {
  let bodyText: string | undefined;
  let bodyHtml: string | undefined;
  const attachments: NonNullable<EmailFull["attachments"]> = [];

  function walk(part: GmailMessagePart, partPrefix: string): void {
    const mime = part.mimeType ?? "";

    if (mime === "text/plain" && bodyText === undefined) {
      bodyText = decodeBody(part.body ?? {});
      return;
    }
    if (mime === "text/html" && bodyHtml === undefined) {
      bodyHtml = decodeBody(part.body ?? {});
      return;
    }

    if (part.parts) {
      for (let i = 0; i < part.parts.length; i++) {
        walk(part.parts[i]!, (partPrefix ? `${partPrefix}.` : "") + String(i));
      }
      return;
    }

    const topType = mime.split("/")[0] ?? "";
    const hasFilename = !!part.filename || !!part.body?.attachmentId;
    const isAttachment =
      hasFilename ||
      (!!mime && topType !== "text" && topType !== "multipart");

    if (isAttachment && part.body?.attachmentId) {
      attachments.push({
        id: part.body.attachmentId,
        name: part.filename ?? part.partId ?? "attachment",
        contentType: mime || undefined,
        size: part.body.size != null ? Number(part.body.size) : undefined,
      });
    }
  }

  walk(payload, prefix);
  return { bodyText, bodyHtml, attachments };
}

/** Build a native Gmail link for a Gmail message ID in this account. */
export function gmailMessageWebLink(
  account: AccountRecord,
  messageId: string | null | undefined,
): EmailWebLinkFields {
  if (!messageId) {
    return {
      webUrlUnavailableReason:
        "Gmail did not return a usable resulting message ID for a native web link.",
    };
  }

  return {
    webUrl: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account.email)}#all/${messageId}`,
  };
}

export function mapSummary(
  account: AccountRecord,
  id: string,
  headers: GmailMessagePart["headers"],
  flags: { labelIds?: (string | null)[] | null; internalDate?: string | null },
): EmailSummary {
  return {
    id,
    ...gmailMessageWebLink(account, id),
    subject: findHeader(headers, "Subject") ?? "",
    from: mapHeaderAddr(findHeader(headers, "From"))[0],
    to: mapHeaderAddr(findHeader(headers, "To")),
    receivedAt: flags.internalDate
      ? new Date(Number(flags.internalDate)).toISOString()
      : undefined,
    preview: undefined,
    isRead: !(flags.labelIds?.includes("UNREAD") ?? false),
    hasAttachments: false,
  };
}

export function mapFolder(label: gmail_v1.Schema$Label): FolderInfo {
  return {
    id: label.id ?? "",
    displayName: label.name ?? "",
    parentFolderId: undefined,
    childFolderCount: 0,
    totalItemCount: label.messagesTotal ?? 0,
    unreadItemCount: label.messagesUnread ?? 0,
  };
}

// ── limit clamping ──

export function clampLimit(
  v: number | undefined,
  dflt: number,
  max: number,
): number {
  if (!v || v <= 0) return dflt;
  return Math.min(v, max);
}

/** Run an async function over items with limited concurrency. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]!);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ── RFC 2822 message building (reuses nodemailer) ──

export function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build a raw RFC 2822 message string from send/draft input.
 * Uses nodemailer's MailComposer for MIME construction, then
 * base64url-encodes the result for the Gmail API `raw` field.
 */
export async function buildRawMessage(
  account: AccountRecord,
  msg: SendInput,
  messageId?: string,
  reference?: ParsedMail,
): Promise<{ raw: string; threadId?: string }> {
  const { body: transformed, images } = parseInlineImages(msg.body);

  const mailOptions: SendMailOptions = {
    from: { name: account.displayName ?? "", address: account.email },
    to: msg.to.map((address) => ({ ...address, name: address.name ?? "" })),
    subject: msg.subject,
    attachDataUrls: true,
  };

  if (msg.isHtml) {
    mailOptions.html = transformed;
  } else {
    mailOptions.text = transformed;
  }

  if (msg.cc && msg.cc.length > 0) {
    mailOptions.cc = msg.cc.map((address) => ({ ...address, name: address.name ?? "" }));
  }
  if (msg.bcc && msg.bcc.length > 0) {
    mailOptions.bcc = msg.bcc.map((address) => ({ ...address, name: address.name ?? "" }));
  }

  if (images.length > 0) {
    mailOptions.attachments = images.map((img) => ({
      filename: img.filename,
      content: Buffer.from(img.contentBytes, "base64"),
      contentType: img.contentType,
      cid: img.cid,
    }));
  }

  // Add file attachments from msg.attachments
  if (msg.attachments && msg.attachments.length > 0) {
    const fileAttachments = msg.attachments.map((att) => ({
      filename: att.name,
      content: Buffer.from(att.contentBytes, "base64"),
      contentType: att.contentType,
    }));
    mailOptions.attachments = [
      ...(mailOptions.attachments ?? []),
      ...fileAttachments,
    ];
  }

  if (messageId) {
    mailOptions.messageId = messageId;
  }

  if (reference) applyParsedReference(mailOptions, reference, msg, account.email);
  const compiled = new MailComposer(mailOptions).compile();
  compiled.keepBcc = true;
  const raw = await new Promise<Buffer>((resolve, reject) => {
    compiled.build((error: Error | null, bytes: Buffer) => error ? reject(error) : resolve(bytes));
  });

  return { raw: base64urlEncode(raw) };
}
