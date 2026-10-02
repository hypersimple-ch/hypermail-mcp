import type { gmail_v1 } from "googleapis";
import { Buffer } from "node:buffer";

import { simpleParser } from "mailparser";
import { buildParsedDraft, matchingAttachmentIndex } from "../shared/draft-mime.js";

import type { AccountRecord } from "../../store/account-store.js";
import type {
  CreateFolderInput,
  DraftUpdateInput,
  EmailReference,
  FolderInfo,
  SendInput,
} from "../types.js";
import {
  GmailClientFactory,
} from "./client.js";
import {
  base64urlEncode,
  buildRawMessage,
  mapFolder,
  gmailMessageWebLink,
  resolveLabel,
  resolveLabelsForMove,
} from "./helpers.js";

/**
 * Write operations for Gmail — send, draft, move, mark, folders.
 */

export async function resolveDraftId(gmail: gmail_v1.Gmail, messageId: string): Promise<string> {
  let pageToken: string | undefined;
  do {
    const response = await gmail.users.drafts.list({ userId: "me", pageToken });
    const draft = response.data.drafts?.find((entry) => entry.message?.id === messageId);
    if (draft?.id) return draft.id;
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  throw new Error(`draft not found: ${messageId}`);
}

async function prepareMessage(gmail: gmail_v1.Gmail, account: AccountRecord, msg: SendInput) {
  const referenceId = msg.forwardMessageId || msg.inReplyTo;
  if (!referenceId) return buildRawMessage(account, msg);
  const response = await gmail.users.messages.get({ userId: "me", id: referenceId, format: "raw" });
  if (!response.data.raw) throw new Error(`reference message not found: ${referenceId}`);
  const parsed = await simpleParser(Buffer.from(response.data.raw, "base64url"), { skipImageLinks: true });
  const result = await buildRawMessage(account, msg, undefined, parsed);
  return { ...result, threadId: msg.forwardMessageId ? undefined : response.data.threadId ?? undefined };
}

function messageReference(account: AccountRecord, id: string | null | undefined): EmailReference {
  if (!id) throw new Error("Gmail mutation succeeded but response has no message ID");
  return { id, ...gmailMessageWebLink(account, id) };
}

export async function sendEmail(clients: GmailClientFactory, account: AccountRecord, msg: SendInput): Promise<EmailReference> {
  const { gmail } = clients.get(account);
  const message = await prepareMessage(gmail, account, msg);
  const response = await gmail.users.messages.send({ userId: "me", requestBody: message });
  return messageReference(account, response.data.id);
}

export async function saveDraft(clients: GmailClientFactory, account: AccountRecord, msg: SendInput): Promise<EmailReference> {
  const { gmail } = clients.get(account);
  const message = await prepareMessage(gmail, account, msg);
  const response = await gmail.users.drafts.create({ userId: "me", requestBody: { message } });
  return messageReference(account, response.data.message?.id);
}

export async function updateDraft(clients: GmailClientFactory, account: AccountRecord, id: string, update: DraftUpdateInput): Promise<EmailReference> {
  const { gmail } = clients.get(account);
  const draftId = await resolveDraftId(gmail, id);
  const response = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "raw" });
  if (!response.data.message?.raw) throw new Error(`draft not found: ${id}`);
  const parsed = await simpleParser(Buffer.from(response.data.message.raw, "base64url"), { skipImageLinks: true });
  const raw = await buildParsedDraft(parsed, update, parsed.attachments);
  const updated = await gmail.users.drafts.update({ userId: "me", id: draftId, requestBody: { message: { raw: base64urlEncode(raw), threadId: response.data.message.threadId } } });
  return messageReference(account, updated.data.message?.id);
}

export function isTrashDestination(destinationId: string): boolean {
  const lower = destinationId.toLowerCase();
  return lower === "deleteditems" || lower === "trash";
}

export async function moveEmail(
  clients: GmailClientFactory,
  account: AccountRecord,
  id: string,
  destinationId: string,
): Promise<EmailReference> {
  if (isTrashDestination(destinationId)) {
    return trashEmail(clients, account, id);
  }

  const { gmail } = clients.get(account);
  const { addLabelIds, removeLabelIds } =
    resolveLabelsForMove(destinationId);

  await gmail.users.messages.modify({
    userId: "me",
    id,
    requestBody: { addLabelIds, removeLabelIds },
  });
  return { id, ...gmailMessageWebLink(account, id) };
}

export async function trashEmail(
  clients: GmailClientFactory,
  account: AccountRecord,
  id: string,
): Promise<EmailReference> {
  const { gmail } = clients.get(account);
  const res = await gmail.users.messages.trash({
    userId: "me",
    id,
  });
  const messageId = res.data.id ?? id;
  return { id: messageId, ...gmailMessageWebLink(account, messageId) };
}

export async function sendDraft(clients: GmailClientFactory, account: AccountRecord, id: string): Promise<EmailReference> {
  const { gmail } = clients.get(account);
  const draftId = await resolveDraftId(gmail, id);
  const response = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
  return messageReference(account, response.data.id);
}

async function attachmentParts(gmail: gmail_v1.Gmail, messageId: string) {
  const response = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const parts: gmail_v1.Schema$MessagePart[] = [];
  const visit = (part: gmail_v1.Schema$MessagePart) => {
    if (part.body?.attachmentId) parts.push(part);
    for (const child of part.parts ?? []) visit(child);
  };
  if (response.data.payload) visit(response.data.payload);
  return parts;
}

async function attachmentBytes(gmail: gmail_v1.Gmail, messageId: string, attachmentId: string): Promise<Buffer> {
  const response = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  if (response.data.data == null) throw new Error(`attachment data missing: ${attachmentId}`);
  return Buffer.from(response.data.data, "base64url");
}

export async function addAttachmentToDraft(clients: GmailClientFactory, account: AccountRecord, messageId: string, name: string, contentBytes: string, contentType = "application/octet-stream") {
  const { gmail } = clients.get(account);
  const draftId = await resolveDraftId(gmail, messageId);
  const response = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "raw" });
  if (!response.data.message?.raw) throw new Error(`draft not found: ${messageId}`);
  const parsed = await simpleParser(Buffer.from(response.data.message.raw, "base64url"), { skipImageLinks: true });
  const bytes = Buffer.from(contentBytes, "base64");
  const ordinal = parsed.attachments.filter((attachment) => attachment.filename === name && attachment.contentType === contentType && attachment.content.equals(bytes)).length;
  const added = { filename: name, content: bytes, contentType, contentDisposition: "attachment" } as typeof parsed.attachments[number];
  const raw = await buildParsedDraft(parsed, {}, [...parsed.attachments, added]);
  const updated = await gmail.users.drafts.update({ userId: "me", id: draftId, requestBody: { message: { raw: base64urlEncode(raw), threadId: response.data.message.threadId } } });
  const reference = messageReference(account, updated.data.message?.id);
  let matching = 0;
  for (const part of await attachmentParts(gmail, reference.id)) {
    if (part.filename !== name || part.mimeType !== contentType) continue;
    const id = part.body!.attachmentId!;
    if ((await attachmentBytes(gmail, reference.id, id)).equals(bytes) && matching++ === ordinal) return { id: reference.id, attachment: { id, name, contentType } };
  }
  throw new Error(`Gmail draft ${reference.id} was updated but added attachment is not readable`);
}

export async function removeAttachmentsFromDraft(clients: GmailClientFactory, account: AccountRecord, messageId: string, attachmentIds: string[]): Promise<EmailReference> {
  const { gmail } = clients.get(account);
  const draftId = await resolveDraftId(gmail, messageId);
  const response = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "raw" });
  if (!response.data.message?.raw) throw new Error(`draft not found: ${messageId}`);
  const parsed = await simpleParser(Buffer.from(response.data.message.raw, "base64url"), { skipImageLinks: true });
  const retained = [...parsed.attachments];
  const parts = await attachmentParts(gmail, messageId);
  for (const id of new Set(attachmentIds)) {
    const part = parts.find((entry) => entry.body?.attachmentId === id);
    if (!part) throw new Error(`attachment not found: ${id}`);
    const bytes = await attachmentBytes(gmail, messageId, id);
    const index = matchingAttachmentIndex(retained, part.filename ?? undefined, part.mimeType ?? undefined, bytes);
    if (index < 0) throw new Error(`cannot map attachment MIME part: ${id}`);
    retained.splice(index, 1);
  }
  const raw = await buildParsedDraft(parsed, {}, retained);
  const updated = await gmail.users.drafts.update({ userId: "me", id: draftId, requestBody: { message: { raw: base64urlEncode(raw), threadId: response.data.message.threadId } } });
  return messageReference(account, updated.data.message?.id);
}

export async function markRead(
  clients: GmailClientFactory,
  account: AccountRecord,
  id: string,
  isRead: boolean,
): Promise<EmailReference> {
  const { gmail } = clients.get(account);
  await gmail.users.messages.modify({
    userId: "me",
    id,
    requestBody: {
      removeLabelIds: isRead ? ["UNREAD"] : undefined,
      addLabelIds: isRead ? undefined : ["UNREAD"],
    },
  });
  return { id, ...gmailMessageWebLink(account, id) };
}

export async function createFolder(
  clients: GmailClientFactory,
  account: AccountRecord,
  input: CreateFolderInput,
): Promise<FolderInfo> {
  const { gmail } = clients.get(account);
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: input.displayName,
      messageListVisibility: "show",
      labelListVisibility: "labelShow",
    },
  });
  return mapFolder(created.data);
}

export async function renameFolder(
  clients: GmailClientFactory,
  account: AccountRecord,
  folderId: string,
  newName: string,
): Promise<FolderInfo> {
  const { gmail } = clients.get(account);
  const updated = await gmail.users.labels.patch({
    userId: "me",
    id: folderId,
    requestBody: { name: newName },
  });
  return mapFolder(updated.data);
}

export async function deleteFolder(
  clients: GmailClientFactory,
  account: AccountRecord,
  folderId: string,
): Promise<void> {
  const { gmail } = clients.get(account);
  await gmail.users.labels.delete({
    userId: "me",
    id: folderId,
  });
}
