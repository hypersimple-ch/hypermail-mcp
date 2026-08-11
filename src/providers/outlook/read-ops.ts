import { ResponseType } from "@microsoft/microsoft-graph-client";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import type { Client } from "@microsoft/microsoft-graph-client";

import type { AccountRecord } from "../../store/account-store.js";
import type {
  AttachmentContent,
  EmailFull,
  EmailSummary,
  ListEmailsOptions,
  ListEmailsResult,
  SearchEmailsOptions,
} from "../types.js";
import {
  OUTLOOK_IMMUTABLE_ID_PREFER,
  resolveOutlookWebLink,
  resolveOutlookWebLinks,
} from "./web-links.js";

export { OUTLOOK_IMMUTABLE_ID_PREFER } from "./web-links.js";

import {
  clampLimit,
  type GraphAttachment,
  type GraphFolder,
  type GraphMessage,
  mapRecipient,
  mapSummary,
} from "./helpers.js";

const MESSAGE_SELECT = [
  "id",
  "subject",
  "from",
  "toRecipients",
  "receivedDateTime",
  "bodyPreview",
  "isRead",
  "hasAttachments",
  "webLink",
  "parentFolderId",
].join(",");

const FULL_MESSAGE_SELECT = [
  "id",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "receivedDateTime",
  "bodyPreview",
  "isRead",
  "hasAttachments",
  "webLink",
  "parentFolderId",
  "body",
].join(",");

type ExchangeSourceIdType = "ewsId" | "restId";

const EXCHANGE_ID_TRANSLATION_SOURCE_TYPES: ExchangeSourceIdType[] = [
  "ewsId",
  "restId",
];

interface TranslateExchangeIdsResponse {
  value?: Array<{ sourceId?: string; targetId?: string }>;
}

function graphErrorFields(err: unknown): Array<string | number> {
  if (typeof err !== "object" || err === null) {
    return [String(err)];
  }

  const record = err as Record<string, unknown>;
  const fields: Array<string | number> = [];
  for (const key of ["code", "statusCode", "message"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") fields.push(value);
  }

  if (typeof record.body === "string") {
    try {
      const parsed = JSON.parse(record.body) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const graphError = (parsed as Record<string, unknown>).error;
        if (typeof graphError === "object" && graphError !== null) {
          const graphRecord = graphError as Record<string, unknown>;
          for (const key of ["code", "message"]) {
            const value = graphRecord[key];
            if (typeof value === "string" || typeof value === "number") {
              fields.push(value);
            }
          }
        }
      }
    } catch {
      fields.push(record.body);
    }
  }

  return fields;
}

export function isStaleMessageIdError(err: unknown): boolean {
  const fields = graphErrorFields(err);
  if (fields.some((value) => value === 404)) return true;

  return fields.some((value) => {
    if (typeof value !== "string") return false;
    const normalized = value.toLowerCase();
    return (
      normalized.includes("erroritemnotfound") ||
      normalized.includes("invalidid") ||
      normalized.includes("object was not found in the store") ||
      normalized.includes("not found in the store")
    );
  });
}

async function translateMessageIdToImmutable(
  client: Client,
  id: string,
): Promise<string | undefined> {
  for (const sourceIdType of EXCHANGE_ID_TRANSLATION_SOURCE_TYPES) {
    try {
      const res = (await client.api("/me/translateExchangeIds").post({
        inputIds: [id],
        sourceIdType,
        targetIdType: "restImmutableEntryId",
      })) as TranslateExchangeIdsResponse;
      const targetId = res.value?.find((item) => item.targetId)?.targetId;
      if (typeof targetId === "string" && targetId !== "" && targetId !== id) {
        return targetId;
      }
    } catch {
      // Best-effort fallback only: callers keep the original read/probe error.
    }
  }

  return undefined;
}

async function probeMessage(
  client: Client,
  id: string,
  useImmutableIds: boolean,
): Promise<void> {
  let req = client
    .api(`/me/messages/${encodeURIComponent(id)}`)
    .select("id");
  if (useImmutableIds) req = req.header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER);
  await req.get();
}

async function probeSearchResult(client: Client, id: string): Promise<string | undefined> {
  try {
    await probeMessage(client, id, true);
    return id;
  } catch (err) {
    if (!isStaleMessageIdError(err)) throw err;
  }

  // Backward compatibility for any result ID Graph still returns as a legacy mutable ID.
  try {
    await probeMessage(client, id, false);
    return id;
  } catch (err) {
    if (!isStaleMessageIdError(err)) throw err;
  }

  const translatedId = await translateMessageIdToImmutable(client, id);
  if (!translatedId) return undefined;

  try {
    await probeMessage(client, translatedId, true);
    return translatedId;
  } catch (err) {
    if (!isStaleMessageIdError(err)) throw err;
    return undefined;
  }
}

async function getMessageById(
  client: Client,
  id: string,
  useImmutableIds: boolean,
): Promise<GraphMessage> {
  let req = client
    .api(`/me/messages/${encodeURIComponent(id)}`)
    .select(FULL_MESSAGE_SELECT);
  if (useImmutableIds) req = req.header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER);
  return (await req.get()) as GraphMessage;
}

async function getMessage(
  client: Client,
  id: string,
): Promise<{ message: GraphMessage; useImmutableIds: boolean }> {
  let lastStaleError: unknown;

  try {
    return { message: await getMessageById(client, id, true), useImmutableIds: true };
  } catch (err) {
    if (!isStaleMessageIdError(err)) throw err;
    lastStaleError = err;
  }

  try {
    return { message: await getMessageById(client, id, false), useImmutableIds: false };
  } catch (err) {
    if (!isStaleMessageIdError(err)) throw err;
    lastStaleError = err;
  }

  const translatedId = await translateMessageIdToImmutable(client, id);
  if (translatedId) {
    try {
      return {
        message: await getMessageById(client, translatedId, true),
        useImmutableIds: true,
      };
    } catch (err) {
      if (!isStaleMessageIdError(err)) throw err;
      lastStaleError = err;
    }
  }

  throw lastStaleError ?? new Error("Message not found");
}

async function listAttachments(
  client: Client,
  messageId: string,
  useImmutableIds: boolean,
): Promise<GraphAttachment[]> {
  let req = client
    .api(`/me/messages/${encodeURIComponent(messageId)}/attachments`)
    .select("id,name,contentType,size");
  if (useImmutableIds) req = req.header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER);

  const attRes = (await req.get()) as { value: GraphAttachment[] };
  return attRes.value;
}

async function getAttachmentMetadata(
  client: Client,
  messageId: string,
  attachmentId: string,
  useImmutableIds: boolean,
): Promise<{ name: string; contentType?: string }> {
  let req = client
    .api(`/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`)
    .select("name,contentType");
  if (useImmutableIds) req = req.header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER);

  return (await req.get()) as { name: string; contentType?: string };
}

async function getAttachmentValue(
  client: Client,
  messageId: string,
  attachmentId: string,
  useImmutableIds: boolean,
): Promise<ArrayBuffer> {
  let req = client
    .api(`/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`)
    .responseType(ResponseType.ARRAYBUFFER);
  if (useImmutableIds) req = req.header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER);

  return (await req.get()) as ArrayBuffer;
}

async function listMessagePage(
  client: Client,
  folder: string,
  limit: number,
  skip: number,
  filterParts: string[],
): Promise<{ value: GraphMessage[]; "@odata.nextLink"?: string }> {
  let req = client
    .api(`/me/mailFolders/${encodeURIComponent(folder)}/messages`)
    .header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER)
    .top(limit)
    .skip(skip)
    .select(MESSAGE_SELECT)
    .orderby("receivedDateTime DESC");

  if (filterParts.length > 0) req = req.filter(filterParts.join(" and "));

  return (await req.get()) as { value: GraphMessage[]; "@odata.nextLink"?: string };
}

function normalizeFolderDisplayName(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

async function resolveFolderIdByDisplayName(
  client: Client,
  displayName: string,
): Promise<string | undefined> {
  const wanted = normalizeFolderDisplayName(displayName);
  if (!wanted) return undefined;

  const res = (await client
    .api("/me/mailFolders")
    .top(100)
    .select("id,displayName")
    .get()) as { value?: GraphFolder[] };

  return (res.value ?? []).find(
    (folder) => normalizeFolderDisplayName(folder.displayName) === wanted,
  )?.id;
}

export async function listEmails(
  client: Client,
  account: AccountRecord,
  opts: ListEmailsOptions,
): Promise<ListEmailsResult> {
  const limit = clampLimit(opts.limit, 25, 100);
  const folder = opts.folder ?? "inbox";
  const filterParts: string[] = [];
  if (opts.unreadOnly) filterParts.push("isRead eq false");

  let res: { value: GraphMessage[]; "@odata.nextLink"?: string };
  try {
    res = await listMessagePage(client, folder, limit, opts.skip ?? 0, filterParts);
  } catch (err) {
    if (!isStaleMessageIdError(err)) throw err;
    const resolvedFolderId = await resolveFolderIdByDisplayName(client, folder);
    if (!resolvedFolderId || resolvedFolderId === folder) throw err;
    res = await listMessagePage(client, resolvedFolderId, limit, opts.skip ?? 0, filterParts);
  }

  const webLinks = await resolveOutlookWebLinks(client, res.value.map((message) => ({
    id: message.id,
    graphWebLink: message.webLink,
  })));

  return {
    items: res.value.map((message) => ({
      ...mapSummary(message, folder),
      ...webLinks.get(message.id),
    })),
    hasMore: !!res["@odata.nextLink"],
  };
}

function escapeKqlValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildSearchKql(opts: SearchEmailsOptions): string {
  const terms: string[] = [];
  if (opts.query !== undefined) terms.push(escapeKqlValue(opts.query));
  if (opts.from !== undefined) terms.push(`from:\\"${escapeKqlValue(opts.from)}\\"`);
  if (opts.to !== undefined) terms.push(`to:\\"${escapeKqlValue(opts.to)}\\"`);
  if (opts.cc !== undefined) {
    const cc = escapeKqlValue(opts.cc);
    terms.push(`(cc:\\"${cc}\\" OR bcc:\\"${cc}\\")`);
  }
  return `"${terms.join(" AND ")}"`;
}

export async function searchEmails(
  client: Client,
  account: AccountRecord,
  opts: SearchEmailsOptions,
): Promise<EmailSummary[]> {
  const limit = clampLimit(opts.limit, 25, 100);
  // $search requires the ConsistencyLevel: eventual header
  const res = (await client
    .api("/me/messages")
    .header("ConsistencyLevel", "eventual")
    .header("Prefer", OUTLOOK_IMMUTABLE_ID_PREFER)
    .top(limit)
    .search(buildSearchKql(opts))
    .select(MESSAGE_SELECT)
    .get()) as { value: GraphMessage[] };

  const probed = await Promise.all(
    res.value.map(async (message) => ({
      message,
      readableId: await probeSearchResult(client, message.id),
    })),
  );
  const webLinks = await resolveOutlookWebLinks(client, probed.map(({ message, readableId }) => ({
    id: readableId ?? message.id,
    graphWebLink: message.webLink,
  })));

  return probed.map(({ message, readableId }) => {
    const resolvedId = readableId ?? message.id;
    const summary = {
      ...mapSummary(message),
      id: resolvedId,
      ...webLinks.get(resolvedId),
    };
    return readableId ? summary : { ...summary, stale: true };
  });
}

export async function readEmail(
  client: Client,
  account: AccountRecord,
  id: string,
): Promise<EmailFull> {
  const { message: m, useImmutableIds } = await getMessage(client, id);

  let attachments: EmailFull["attachments"] = undefined;
  if (m.hasAttachments) {
    try {
      const attRes = await listAttachments(client, m.id, useImmutableIds);
      attachments = attRes.map((a) => ({
        id: a.id,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
      }));
    } catch {
      /* ignore attachment listing failure */
    }
  }

  const summary = {
    ...mapSummary(m),
    ...(await resolveOutlookWebLink(
      client,
      m.id,
      m.webLink,
      useImmutableIds ? "restImmutableEntryId" : "restId",
    )),
  };
  const body = m.body;
  return {
    ...summary,
    cc: (m.ccRecipients ?? []).map(mapRecipient),
    bcc: (m.bccRecipients ?? []).map(mapRecipient),
    bodyText: body?.contentType === "text" ? body.content : undefined,
    bodyHtml: body?.contentType === "html" ? body.content : undefined,
    attachments,
  };
}

export async function readAttachment(
  client: Client,
  account: AccountRecord,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentContent> {
  let useImmutableIds = true;
  let att: { name: string; contentType?: string };

  try {
    att = await getAttachmentMetadata(client, messageId, attachmentId, true);
  } catch (err) {
    if (!isStaleMessageIdError(err)) throw err;
    useImmutableIds = false;
    att = await getAttachmentMetadata(client, messageId, attachmentId, false);
  }

  let data: ArrayBuffer;
  try {
    data = await getAttachmentValue(client, messageId, attachmentId, useImmutableIds);
  } catch (err) {
    if (!useImmutableIds || !isStaleMessageIdError(err)) throw err;
    data = await getAttachmentValue(client, messageId, attachmentId, false);
  }

  // Write to temp file with original name
  const outPath = pathJoin(tmpdir(), att.name);
  writeFileSync(outPath, Buffer.from(data));

  let webLinkFields;
  try {
    const { message, useImmutableIds: messageUsesImmutableIds } = await getMessage(client, messageId);
    webLinkFields = await resolveOutlookWebLink(
      client,
      message.id,
      message.webLink,
      messageUsesImmutableIds ? "restImmutableEntryId" : "restId",
    );
  } catch {
    webLinkFields = {
      webUrlUnavailableReason: "Unable to resolve the parent message's Outlook web link.",
    };
  }

  return {
    name: att.name,
    contentType: att.contentType,
    path: outPath,
    ...webLinkFields,
  };
}
