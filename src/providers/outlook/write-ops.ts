import type { Client } from "@microsoft/microsoft-graph-client";
import type { AccountRecord } from "../../store/account-store.js";
import type { DraftUpdateInput, EmailReference, SendInput } from "../types.js";
import {
  convertInlineImages,
  type GraphMessage,
  type InlineAttachment,
  toRecipient,
} from "./helpers.js";
import { OUTLOOK_IMMUTABLE_ID_PREFER, resolveOutlookWebLink } from "./web-links.js";

/** Hidden HTML comment placed at the thread boundary to survive Graph HTML normalization. */
export const THREAD_MARKER = "<!-- hypermail-thread-boundary -->";

const MESSAGE_REFERENCE_SELECT = "id,webLink,parentFolderId";
const REPRESENTATION_PREFER = `return=representation, ${OUTLOOK_IMMUTABLE_ID_PREFER}`;

async function fetchMessageRepresentation(client: Client, id: string): Promise<GraphMessage> {
  const endpoint = `/me/messages/${encodeURIComponent(id)}`;
  try {
    return (await client
      .api(endpoint)
      .header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER)
      .select(MESSAGE_REFERENCE_SELECT)
      .get()) as GraphMessage;
  } catch (immutableError) {
    try {
      return (await client.api(endpoint).select(MESSAGE_REFERENCE_SELECT).get()) as GraphMessage;
    } catch {
      throw immutableError;
    }
  }
}

async function messageReference(
  client: Client,
  message: Partial<GraphMessage> | undefined,
  fallbackId: string,
): Promise<EmailReference> {
  const id = message?.id ?? fallbackId;
  if (!id) {
    return { id, webUrlUnavailableReason: "Outlook did not return an ID for the resulting sent message." };
  }

  let resolved = message;
  if (!resolved?.webLink) {
    try {
      resolved = await fetchMessageRepresentation(client, id);
    } catch {
      // Link resolution is best-effort.
    }
  }
  return { id: resolved?.id ?? id, ...(await resolveOutlookWebLink(client, resolved?.id ?? id, resolved?.webLink)) };
}

async function resolveFolderId(client: Client, destinationId: string): Promise<string> {
  const folder = (await client
    .api(`/me/mailFolders/${encodeURIComponent(destinationId)}`)
    .select("id")
    .get()) as { id?: string };
  if (!folder.id) throw new Error(`Outlook destination folder could not be resolved: ${destinationId}`);
  return folder.id;
}

function isTextBody(contentType: string | undefined): boolean {
  return contentType?.toLowerCase() === "text";
}

function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function hasMeaningfulHtmlTag(html: string): boolean {
  return /<\/?(?:p|div|br|blockquote|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|a|span|font|b|strong|em|i|u|img|hr|pre)\b/i.test(html);
}

function wrapQuotedHistory(content: string): string {
  return `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${content}</blockquote>`;
}

function normalizeDraftBody(content: string, contentType: string | undefined): string {
  if (isTextBody(contentType)) return textToHtml(content);
  if (contentType?.toLowerCase() !== "html") return content;

  const bodyMatch = /(<body\b[^>]*>)([\s\S]*?)(<\/body>)/i.exec(content);
  const inner = bodyMatch ? (bodyMatch[2] ?? "") : content;
  if (inner.trim() === "" || hasMeaningfulHtmlTag(inner)) return content;

  const normalized = wrapQuotedHistory(textToHtml(inner));
  if (!bodyMatch) return normalized;

  const bodyOpen = bodyMatch[1] ?? "";
  const bodyClose = bodyMatch[3] ?? "";
  return (
    content.slice(0, bodyMatch.index) +
    bodyOpen +
    normalized +
    bodyClose +
    content.slice(bodyMatch.index + bodyMatch[0].length)
  );
}

/**
 * Creates a draft from a reference message (forward or reply), prepends our
 * composed body before the existing content, and attaches inline images.
 * Returns the draft message ID.
 */
export async function buildDraftFromReference(
  client: Client,
  createEndpoint: string,
  createPayload: Record<string, unknown>,
  converted: { body: string; attachments: InlineAttachment[] },
): Promise<string> {
  const draft: { id: string } = await client
    .api(createEndpoint)
    .header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER)
    .post(createPayload);

  const draftMsg: { body?: { content?: string; contentType?: string } } =
    await client.api(`/me/messages/${draft.id}`).select("body").get();

  const rawDraftBody = draftMsg.body?.content ?? "";
  const draftBody = normalizeDraftBody(
    rawDraftBody,
    draftMsg.body?.contentType,
  );
  const spacer = '<div style="line-height:12px"><br></div>';
  const prepend = converted.body + spacer + THREAD_MARKER;
  const finalBody = draftBody.includes("<body")
    ? draftBody.replace(/(<body[^>]*>)/i, `$1${prepend}`)
    : prepend + draftBody;

  await client.api(`/me/messages/${draft.id}`).patch({
    body: { contentType: "HTML", content: finalBody },
  });

  for (const att of converted.attachments) {
    await client.api(`/me/messages/${draft.id}/attachments`).post(att);
  }

  return draft.id;
}

/**
 * Shared backend for sendEmail and saveDraft — handles forward, reply, and
 * new-message paths. The `mode` controls whether the message is sent
 * immediately or saved as a draft.
 */
export async function sendOrSave(
  client: Client,
  account: AccountRecord,
  msg: SendInput,
  mode: "send" | "draft",
): Promise<EmailReference> {
  const converted = convertInlineImages(msg.body);

  const toRecipients = msg.to.map(toRecipient);
  const ccRecipients = (msg.cc ?? []).map(toRecipient);
  const bccRecipients = (msg.bcc ?? []).map(toRecipient);

  // Forward — build a forward draft, then send if mode is "send".
  if (msg.forwardMessageId) {
    const draftId = await buildDraftFromReference(
      client,
      `/me/messages/${encodeURIComponent(msg.forwardMessageId)}/createForward`,
      { message: { toRecipients, ccRecipients, bccRecipients }, comment: "" },
      converted,
    );
    if (mode === "send") {
      await client.api(`/me/messages/${draftId}/send`).post({});
    }
    return messageReference(client, undefined, draftId);
  }

  // Reply — build a reply draft, then send if mode is "send".
  if (msg.inReplyTo) {
    const createEndpoint = msg.replyAll
      ? `/me/messages/${encodeURIComponent(msg.inReplyTo)}/createReplyAll`
      : `/me/messages/${encodeURIComponent(msg.inReplyTo)}/createReply`;
    const draftId = await buildDraftFromReference(
      client, createEndpoint, {}, converted,
    );
    if (mode === "send") {
      await client.api(`/me/messages/${draftId}/send`).post({});
    }
    return messageReference(client, undefined, draftId);
  }

  // New email — sendMail (mode=send) or POST /me/messages (mode=draft).
  const messagePayload: Record<string, unknown> = {
    subject: msg.subject,
    body: {
      contentType: msg.isHtml ? "HTML" : "Text",
      content: converted.body,
    },
    toRecipients,
    ccRecipients,
    bccRecipients,
  };

  // Merge inline attachments (from HTML body) with file attachments
  const allAttachments: unknown[] = [...converted.attachments];
  if (msg.attachments && msg.attachments.length > 0) {
    for (const att of msg.attachments) {
      allAttachments.push({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: att.name,
        contentBytes: att.contentBytes,
        contentType: att.contentType ?? "application/octet-stream",
      });
    }
  }
  if (allAttachments.length > 0) {
    messagePayload.attachments = allAttachments;
  }

  if (mode === "send") {
    await client.api("/me/sendMail").post({
      message: messagePayload,
      saveToSentItems: true,
    });
    // Graph's sendMail returns 202 with no body; no sent item can be resolved.
    return {
      id: "",
      webUrlUnavailableReason: "Outlook did not return an ID for the resulting sent message.",
    };
  }

  const draft = (await client
    .api("/me/messages")
    .header("Prefer", REPRESENTATION_PREFER)
    .post(messagePayload)) as GraphMessage;
  return messageReference(client, draft, draft.id);
}

export async function updateDraft(
  client: Client,
  account: AccountRecord,
  id: string,
  update: DraftUpdateInput,
): Promise<EmailReference> {
  const payload: Record<string, unknown> = {};

  if (update.subject !== undefined) {
    payload.subject = update.subject;
  }
  if (update.to !== undefined) {
    payload.toRecipients = update.to.map(toRecipient);
  }
  if (update.cc !== undefined) {
    payload.ccRecipients = update.cc.map(toRecipient);
  }
  if (update.bcc !== undefined) {
    payload.bccRecipients = update.bcc.map(toRecipient);
  }
  if (update.body !== undefined) {
    const converted = convertInlineImages(update.body);
    payload.body = {
      contentType: update.isHtml ? "HTML" : "Text",
      content: converted.body,
    };
    if (converted.attachments.length > 0) {
      // Patch existing inline attachments: Graph will replace all
      // attachments on the message. We send only the new ones.
      payload.attachments = converted.attachments;
    }
  }

  const updated = (await client
    .api(`/me/messages/${encodeURIComponent(id)}`)
    .header("Prefer", REPRESENTATION_PREFER)
    .patch(payload)) as GraphMessage | undefined;

  return messageReference(client, updated, id);
}

export async function addAttachmentToDraft(
  client: Client,
  account: AccountRecord,
  draftId: string,
  name: string,
  contentBytes: string,
  contentType?: string,
): Promise<{ id: string; attachment: { id: string; name: string; contentType?: string } }> {
  const att = (await client
    .api(`/me/messages/${encodeURIComponent(draftId)}/attachments`)
    .post({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name,
      contentType: contentType ?? "application/octet-stream",
      contentBytes,
    })) as { id: string; name: string; contentType?: string };
  return {
    id: draftId,
    attachment: { id: att.id, name: att.name, contentType: att.contentType },
  };
}

export async function removeAttachmentsFromDraft(
  client: Client,
  account: AccountRecord,
  draftId: string,
  attachmentIds: string[],
): Promise<EmailReference> {
  const ids = [...new Set(attachmentIds)];
  for (const id of ids) {
    await client.api(`/me/messages/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(id)}`).get();
  }
  for (const id of ids) {
    await client.api(`/me/messages/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(id)}`).delete();
  }
  return messageReference(client, await fetchMessageRepresentation(client, draftId), draftId);
}

export async function moveEmail(
  client: Client,
  account: AccountRecord,
  id: string,
  destinationId: string,
): Promise<EmailReference> {
  const expectedFolderId = await resolveFolderId(client, destinationId);
  const moved = (await client
    .api(`/me/messages/${encodeURIComponent(id)}/move`)
    .header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER)
    .post({ destinationId })) as GraphMessage;
  if (!moved.id) throw new Error("Outlook move did not return the moved message ID.");

  const verified = moved.parentFolderId && moved.webLink?.trim()
    ? moved
    : await fetchMessageRepresentation(client, moved.id);
  if (verified.parentFolderId !== expectedFolderId) {
    throw new Error(
      `Outlook move verification failed: expected ${expectedFolderId}, got ${verified.parentFolderId ?? "none"}.`,
    );
  }

  return messageReference(client, { ...verified, id: moved.id }, moved.id);
}

export async function sendDraft(
  client: Client,
  account: AccountRecord,
  id: string,
): Promise<EmailReference> {
  await client.api(`/me/messages/${encodeURIComponent(id)}/send`).post({});
  return messageReference(client, undefined, id);
}

export async function markRead(
  client: Client,
  account: AccountRecord,
  id: string,
  isRead: boolean,
): Promise<EmailReference> {
  const updated = (await client
    .api(`/me/messages/${encodeURIComponent(id)}`)
    .header("Prefer", REPRESENTATION_PREFER)
    .patch({ isRead })) as GraphMessage | undefined;
  return messageReference(client, updated, id);
}
