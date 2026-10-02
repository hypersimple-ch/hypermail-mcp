import { writeAttachmentFile } from "../shared/attachment-files.js";

import type { gmail_v1 } from "googleapis";

import type { AccountRecord } from "../../store/account-store.js";
import type {
  AttachmentContent,
  EmailFull,
  EmailSummary,
  FolderInfo,
  ListEmailsOptions,
  ListEmailsResult,
  ListFoldersOptions,
  SearchEmailsOptions,
  EmailAddress,
} from "../types.js";
import { GmailClientFactory } from "./client.js";
import {
  clampLimit,
  findHeader,
  mapHeaderAddr,
  mapSummary,
  mapFolder,
  gmailMessageWebLink,
  parsePayload,
  pool,
  resolveLabel,
  type GmailMessageListEntry,
} from "./helpers.js";

/**
 * Browse operations for Gmail — list, search, read emails, attachments,
 * and folders.
 */

export async function listEmails(
  clients: GmailClientFactory,
  account: AccountRecord,
  opts: ListEmailsOptions,
): Promise<ListEmailsResult> {
  const { gmail } = clients.get(account);
  const limit = clampLimit(opts.limit, 25, 100);
  const label = resolveLabel(opts.folder ?? "inbox");

  const params: gmail_v1.Params$Resource$Users$Messages$List = {
    userId: "me",
    labelIds: [label],
    maxResults: limit,
  };

  if (opts.unreadOnly) {
    params.q = "is:unread";
  }

  const allIds: GmailMessageListEntry[] = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({ ...params, pageToken });
    if (res.data.messages) allIds.push(...res.data.messages);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && allIds.length < (opts.skip ?? 0) + limit);

  const skip = opts.skip ?? 0;
  const pageIds = allIds.slice(skip, skip + limit);
  const hasMore = skip + limit < allIds.length || Boolean(pageToken);

  if (pageIds.length === 0) {
    return { items: [], hasMore };
  }

  const items = await pool(pageIds, 10, async (entry) => {
    const msgId = entry.id ?? "";
    const msgRes = await gmail.users.messages.get({
      userId: "me",
      id: msgId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "To", "Date"],
    });
    const msg = msgRes.data;
    return mapSummary(account, msgId, msg.payload?.headers ?? [], {
      labelIds: msg.labelIds,
      internalDate: msg.internalDate,
    });
  });

  return { items, hasMore };
}

function quoteSearchValue(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

function buildSearchQuery(opts: SearchEmailsOptions): string | undefined {
  const parts = [opts.query];

  if (opts.from) parts.push(`from:${quoteSearchValue(opts.from)}`);
  if (opts.to) parts.push(`to:${quoteSearchValue(opts.to)}`);
  if (opts.cc) {
    const value = quoteSearchValue(opts.cc);
    parts.push(`(cc:${value} OR bcc:${value})`);
  }

  return (
    parts.filter((part): part is string => Boolean(part)).join(" ") || undefined
  );
}

export async function searchEmails(
  clients: GmailClientFactory,
  account: AccountRecord,
  opts: SearchEmailsOptions,
): Promise<EmailSummary[]> {
  const { gmail } = clients.get(account);
  const limit = clampLimit(opts.limit, 25, 100);

  const res = await gmail.users.messages.list({
    userId: "me",
    q: buildSearchQuery(opts),
    maxResults: limit,
  });

  const ids = res.data.messages ?? [];
  if (ids.length === 0) return [];

  const items = await pool(ids, 10, async (entry) => {
    const msgId = entry.id ?? "";
    const msgRes = await gmail.users.messages.get({
      userId: "me",
      id: msgId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "To", "Date"],
    });
    const msg = msgRes.data;
    return mapSummary(account, msgId, msg.payload?.headers ?? [], {
      labelIds: msg.labelIds,
      internalDate: msg.internalDate,
    });
  });

  return items;
}

export async function readEmail(
  clients: GmailClientFactory,
  account: AccountRecord,
  id: string,
): Promise<EmailFull> {
  const { gmail } = clients.get(account);

  const res = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });

  const msg = res.data;
  if (!msg) throw new Error(`message not found: ${id}`);

  const headers = msg.payload?.headers ?? [];
  const { bodyText, bodyHtml, attachments } = parsePayload(msg.payload ?? {});

  const summary = mapSummary(account, id, headers, {
    labelIds: msg.labelIds,
    internalDate: msg.internalDate,
  });

  return {
    ...summary,
    cc: mapHeaderAddr(findHeader(headers, "Cc")),
    bcc: mapHeaderAddr(findHeader(headers, "Bcc")),
    bodyText,
    bodyHtml,
    attachments: attachments.length > 0 ? attachments : undefined,
    hasAttachments: attachments.length > 0,
  };
}

export async function readAttachment(
  clients: GmailClientFactory,
  account: AccountRecord,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentContent> {
  const { gmail } = clients.get(account);

  const msgRes = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  const { attachments } = parsePayload(msgRes.data.payload ?? {});
  const match = attachments.find((a) => a.id === attachmentId);

  const name = match?.name ?? "attachment";
  const contentType = match?.contentType;

  const attRes = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });

  const data = attRes.data.data;
  if (data == null) throw new Error("attachment data is missing");

  const buf = Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );

  const outPath = await writeAttachmentFile(name, buf);

  return {
    name,
    contentType,
    path: outPath,
    ...gmailMessageWebLink(account, messageId),
  };
}

export async function listFolders(
  clients: GmailClientFactory,
  account: AccountRecord,
  _opts: ListFoldersOptions,
): Promise<FolderInfo[]> {
  const { gmail } = clients.get(account);
  const res = await gmail.users.labels.list({ userId: "me" });
  const labels = res.data.labels ?? [];
  return labels.map(mapFolder);
}
