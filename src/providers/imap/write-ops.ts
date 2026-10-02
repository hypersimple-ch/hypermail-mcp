import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { AccountRecord } from "../../store/account-store.js";
import type { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { buildParsedDraft, matchingAttachmentIndex, parsedAddresses, parsedMailOptions } from "../shared/draft-mime.js";

import type {
  DraftUpdateInput,
  EmailReference,
  SendInput,
} from "../types.js";
import { ImapClientFactory } from "./client.js";
import {
  buildMailOptions,
  buildRawMessage,
} from "./message-builder.js";
import {
  decodeId,
  encodeId,
  findAttachments,
  isTrashFolderAlias,
  webLinkUnavailableReference,
  resolveDraftMailbox,
  resolveFolder,
  resolveTrashMailbox,
} from "./helpers.js";
import type { BodyNode, ImapMailboxEntry } from "./helpers.js";

/** Write operations for IMAP — send, draft, move, mark, folders. */

export async function sendEmail(
  clients: ImapClientFactory,
  account: AccountRecord,
  msg: SendInput,
): Promise<EmailReference> {
  const client = clients.get(account);
  const transporter = client.getTransporter();
  const mailOptions = await buildMailOptions(client, account, msg);
  const info = await transporter.sendMail(mailOptions);

  // Save a copy to Sent folder
  try {
    const compiled = new MailComposer({ ...mailOptions, messageId: info.messageId }).compile();
    const rawMsg = await new Promise<Buffer>((resolve, reject) => {
      compiled.build((error: Error | null, bytes: Buffer) => error ? reject(error) : resolve(bytes));
    });
    await client.run(async (imap) => {
      await imap.append("Sent", rawMsg, ["\\Seen"]);
    });
  } catch {
    /* best-effort */
  }

  return webLinkUnavailableReference(info.messageId);
}

export async function saveDraft(
  clients: ImapClientFactory,
  account: AccountRecord,
  msg: SendInput,
): Promise<EmailReference> {
  const client = clients.get(account);
  const rawMsg = await buildRawMessage(client, account, msg, undefined, true);
  let folder = "Drafts";
  try {
    const result = await client.run(async (imap) => {
      folder = resolveDraftMailbox((await imap.list()) as Iterable<ImapMailboxEntry>);
      return appendDraft(imap, folder, rawMsg);
    });
    return webLinkUnavailableReference(encodeId(folder, appendUid(result, folder)));
  } catch (err) {
    throw imapOperationError(`failed to save IMAP draft to ${folder}`, err);
  }
}

export async function updateDraft(
  clients: ImapClientFactory,
  account: AccountRecord,
  id: string,
  update: DraftUpdateInput,
): Promise<EmailReference> {
  const client = clients.get(account);
  const { folder, uid } = decodeId(id);

  try {
    return await client.withMailbox(folder, async (imap) => {
      const existing = (await imap.fetchOne(
        uid,
        { source: true },
        { uid: true },
      )) as { source?: string | ArrayBuffer };
      if (!existing?.source) {
        throw new Error(`draft not found: ${id}`);
      }

      const source =
        typeof existing.source === "string"
          ? Buffer.from(existing.source, "utf-8")
          : Buffer.from(existing.source);
      const parsed: ParsedMail = await simpleParser(source, { skipImageLinks: true });
      const raw = await buildParsedDraft(parsed, update, parsed.attachments);

      const result = await appendDraft(imap, folder, raw.toString("utf-8"));
      const appendedUid = appendUid(result, folder);
      const appended = (await imap.fetchOne(
        appendedUid,
        { source: true },
        { uid: true },
      )) as { source?: string | ArrayBuffer };
      if (!appended?.source) {
        throw new Error(`appended IMAP draft ${encodeId(folder, appendedUid)} is not readable`);
      }

      try { await imap.messageDelete(uid, { uid: true }); }
      catch (error) { throw imapOperationError(`replacement ${encodeId(folder, appendedUid)} created but original ${id} could not be deleted`, error); }
      return webLinkUnavailableReference(encodeId(folder, appendedUid));
    });
  } catch (err) {
    throw imapOperationError(`failed to update IMAP draft ${id}`, err);
  }
}

export async function moveEmail(
  clients: ImapClientFactory,
  account: AccountRecord,
  id: string,
  destinationId: string,
): Promise<EmailReference> {
  if (isTrashFolderAlias(destinationId)) {
    return trashEmail(clients, account, id);
  }

  const client = clients.get(account);
  const { folder, uid } = decodeId(id);
  const dest = resolveFolder(destinationId);

  return client.withMailbox(folder, async (imap) => {
    const result = await imap.messageMove(uid, dest, { uid: true });
    return movedMessageReference(result, dest, id, uid);
  });
}

export async function trashEmail(
  clients: ImapClientFactory,
  account: AccountRecord,
  id: string,
): Promise<EmailReference> {
  const client = clients.get(account);
  const { folder, uid } = decodeId(id);
  const dest = await client.run(async (imap) =>
    resolveTrashMailbox((await imap.list()) as Iterable<ImapMailboxEntry>),
  );

  return client.withMailbox(folder, async (lockedImap) => {
    const result = await lockedImap.messageMove(uid, dest, { uid: true });
    return movedMessageReference(result, dest, id, uid);
  });
}

export async function sendDraft(
  clients: ImapClientFactory,
  account: AccountRecord,
  id: string,
): Promise<EmailReference> {
  const client = clients.get(account);
  const { folder, uid } = decodeId(id);

  return client.withMailbox(folder, async (imap) => {
    const draft = (await imap.fetchOne(
      uid,
      { source: true },
      { uid: true },
    )) as { source?: string | ArrayBuffer };
    if (!draft?.source) {
      throw new Error(`draft not found: ${id}`);
    }

    const sourceStr =
      typeof draft.source === "string"
        ? draft.source
        : Buffer.from(draft.source as ArrayBuffer).toString("utf-8");

    const parsed = await simpleParser(sourceStr, { skipImageLinks: true });
    const options = parsedMailOptions(parsed);
    const recipients = [...parsedAddresses(parsed.to), ...parsedAddresses(parsed.cc), ...parsedAddresses(parsed.bcc)].map((address) => address.address);
    if (recipients.length === 0) throw new Error(`draft has no recipients: ${id}`);
    options.envelope = { from: parsedAddresses(parsed.from)[0]?.address ?? account.email, to: recipients };
    const transporter = client.getTransporter();
    const info = await transporter.sendMail(options);

    try {
      await imap.messageMove(uid, "Sent", { uid: true });
    } catch {
      /* best-effort */
    }

    return webLinkUnavailableReference(info.messageId);
  });
}

async function readDraft(imap: ImapFlow, uid: number, id: string) {
  const existing = await imap.fetchOne(uid, { source: true, bodyStructure: true }, { uid: true });
  if (!existing || !existing.source) throw new Error(`draft not found: ${id}`);
  if (!existing.bodyStructure) throw new Error(`draft attachment metadata missing: ${id}`);
  return { parsed: await simpleParser(Buffer.from(existing.source), { skipImageLinks: true }), structure: existing.bodyStructure as BodyNode };
}

async function replaceDraft(imap: ImapFlow, folder: string, uid: number, raw: Buffer): Promise<number> {
  const appendedUid = appendUid(await appendDraft(imap, folder, raw.toString("utf-8")), folder);
  const appended = await imap.fetchOne(appendedUid, { source: true }, { uid: true });
  if (!appended || !appended.source) throw new Error(`appended IMAP draft ${encodeId(folder, appendedUid)} is not readable; original ${encodeId(folder, uid)} retained`);
  try { await imap.messageDelete(uid, { uid: true }); }
  catch (error) { throw imapOperationError(`replacement ${encodeId(folder, appendedUid)} created but original ${encodeId(folder, uid)} could not be deleted`, error); }
  return appendedUid;
}

async function downloadPart(imap: ImapFlow, uid: number, part: string): Promise<Buffer> {
  const download = await imap.download(uid, part, { uid: true });
  const chunks: Buffer[] = [];
  for await (const chunk of download.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function addAttachmentToDraft(clients: ImapClientFactory, account: AccountRecord, draftId: string, name: string, contentBytes: string, contentType = "application/octet-stream") {
  const client = clients.get(account);
  const { folder, uid } = decodeId(draftId);
  return client.withMailbox(folder, async (imap) => {
    const { parsed } = await readDraft(imap, uid, draftId);
    const bytes = Buffer.from(contentBytes, "base64");
    const ordinal = parsed.attachments.filter((attachment) => attachment.filename === name && attachment.contentType === contentType && attachment.content.equals(bytes)).length;
    const added = { filename: name, content: bytes, contentType, contentDisposition: "attachment" } as typeof parsed.attachments[number];
    const raw = await buildParsedDraft(parsed, {}, [...parsed.attachments, added]);
    const result = await appendDraft(imap, folder, raw.toString("utf-8"));
    const appendedUid = appendUid(result, folder);
    const final = await readDraft(imap, appendedUid, encodeId(folder, appendedUid));
    let matching = 0;
    let attachmentId: string | undefined;
    for (const part of findAttachments(final.structure)) {
      if (part.name !== name || part.contentType !== contentType) continue;
      if ((await downloadPart(imap, appendedUid, part.part)).equals(bytes) && matching++ === ordinal) { attachmentId = part.part; break; }
    }
    if (!attachmentId) throw new Error(`replacement ${encodeId(folder, appendedUid)} created but added attachment is not readable; original ${draftId} retained`);
    try { await imap.messageDelete(uid, { uid: true }); }
    catch (error) { throw imapOperationError(`replacement ${encodeId(folder, appendedUid)} created but original ${draftId} could not be deleted`, error); }
    return { id: encodeId(folder, appendedUid), attachment: { id: attachmentId, name, contentType } };
  });
}

export async function removeAttachmentsFromDraft(clients: ImapClientFactory, account: AccountRecord, draftId: string, attachmentIds: string[]): Promise<EmailReference> {
  const client = clients.get(account);
  const { folder, uid } = decodeId(draftId);
  return client.withMailbox(folder, async (imap) => {
    const { parsed, structure } = await readDraft(imap, uid, draftId);
    const retained = [...parsed.attachments];
    const parts = findAttachments(structure);
    for (const id of new Set(attachmentIds)) {
      const part = parts.find((entry) => entry.part === id);
      if (!part) throw new Error(`attachment not found: ${id}`);
      const bytes = await downloadPart(imap, uid, id);
      const index = matchingAttachmentIndex(retained, part.name, part.contentType, bytes);
      if (index < 0) throw new Error(`cannot map attachment MIME part: ${id}`);
      retained.splice(index, 1);
    }
    const raw = await buildParsedDraft(parsed, {}, retained);
    return webLinkUnavailableReference(encodeId(folder, await replaceDraft(imap, folder, uid, raw)));
  });
}

export async function markRead(
  clients: ImapClientFactory,
  account: AccountRecord,
  id: string,
  isRead: boolean,
): Promise<EmailReference> {
  const client = clients.get(account);
  const { folder, uid } = decodeId(id);

  return client.withMailbox(folder, async (imap) => {
    if (isRead) {
      await imap.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    } else {
      await imap.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
    }
    return webLinkUnavailableReference(id);
  });
}

function movedMessageReference(
  result: unknown,
  destination: string,
  fallbackId: string,
  sourceUid: number,
): EmailReference {
  const uidMap = result && typeof result === "object"
    ? (result as { uidMap?: unknown }).uidMap
    : undefined;
  const destinationUid = uidMap instanceof Map ? uidMap.get(sourceUid) : undefined;
  const id = typeof destinationUid === "number" && destinationUid > 0
    ? encodeId(destination, destinationUid)
    : fallbackId;
  return webLinkUnavailableReference(id);
}

async function appendDraft(
  imap: ImapFlow,
  folder: string,
  rawMsg: string,
): Promise<unknown> {
  try {
    return await imap.append(folder, rawMsg, ["\\Draft"]);
  } catch (err) {
    if (!isImapCommandFailure(err)) throw err;
    return imap.append(folder, rawMsg);
  }
}

function appendUid(result: unknown, folder: string): number {
  if (!result || typeof result !== "object") {
    throw new Error(`IMAP append to ${folder} did not return a UID`);
  }
  const uid = Number((result as { uid?: unknown }).uid);
  if (Number.isFinite(uid) && uid > 0) return uid;
  throw new Error(`IMAP append to ${folder} did not return a UID`);
}

function isImapCommandFailure(err: unknown): boolean {
  const e = err as { responseStatus?: unknown; message?: unknown };
  return (
    typeof e.responseStatus === "string" ||
    (typeof e.message === "string" && e.message.includes("Command failed"))
  );
}

function imapOperationError(message: string, err: unknown): Error {
  const detail = formatImapError(err);
  return new Error(`${message}: ${detail}`, { cause: err });
}

function formatImapError(err: unknown): string {
  const e = err as Record<string, unknown>;
  const parts: string[] = [];
  const message = err instanceof Error ? err.message : String(err);
  if (message) parts.push(message);

  for (const key of ["responseStatus", "responseText", "serverResponseCode", "response"]) {
    const value = e[key];
    if (value !== undefined && value !== null) {
      parts.push(`${key}=${safeErrorValue(value)}`);
    }
  }

  return parts.join("; ");
}

function safeErrorValue(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = raw ?? String(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
