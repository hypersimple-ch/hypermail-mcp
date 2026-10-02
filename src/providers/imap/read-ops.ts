import { writeAttachmentFile } from "../shared/attachment-files.js";
import type { Readable } from "node:stream";

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
} from "../types.js";
import { ImapClientFactory } from "./client.js";
import {
  BodyNode,
  clampLimit,
  decodeId,
  findAttachments,
  findPartByType,
  ImapEnvelope,
  mapSummary,
  mapEnvelopeAddr,
  mapMailboxToListEntry,
  ImapMailboxEntry,
  resolveFolder,
  IMAP_WEB_URL_UNAVAILABLE_REASON,
} from "./helpers.js";

/**
 * Browse operations for IMAP — list, search, read emails, attachments,
 * and folders. All functions are pure and take the client factory as
 * the first argument so the ImapProvider class can delegate to them.
 */

export async function listEmails(
  clients: ImapClientFactory,
  account: AccountRecord,
  opts: ListEmailsOptions,
): Promise<ListEmailsResult> {
  const client = clients.get(account);
  const folder = resolveFolder(opts.folder ?? "INBOX");
  const limit = clampLimit(opts.limit, 25, 100);
  const skip = opts.skip ?? 0;

  return client.withMailbox(folder, async (imap) => {
    const searchCriteria: Record<string, unknown> = {};
    if (opts.unreadOnly) searchCriteria.seen = false;

    const allUids = (
      Object.keys(searchCriteria).length > 0
        ? await imap.search(searchCriteria, { uid: true })
        : await imap.search({ all: true }, { uid: true })
    ) as number[];

    allUids.sort((a, b) => b - a);
    const pageUids = allUids.slice(skip, skip + limit);
    const hasMore = skip + limit < allUids.length;

    if (pageUids.length === 0) {
      return { items: [], hasMore };
    }

    const messages = await imap.fetchAll(
      pageUids,
      { envelope: true, flags: true },
      { uid: true },
    );

    const items: EmailSummary[] = [];
    for (const msg of messages) {
      items.push(
        mapSummary(
          msg.uid as number,
          folder,
          msg.envelope as ImapEnvelope,
          msg.flags as Set<string>,
        ),
      );
    }
    return { items, hasMore };
  });
}

export async function searchEmails(
  clients: ImapClientFactory,
  account: AccountRecord,
  opts: SearchEmailsOptions,
): Promise<EmailSummary[]> {
  const client = clients.get(account);
  const limit = clampLimit(opts.limit, 25, 100);
  const searchCriteria: Record<string, unknown> = {};

  if (opts.query !== undefined) searchCriteria.text = opts.query;
  if (opts.from !== undefined) searchCriteria.from = opts.from;
  if (opts.to !== undefined) searchCriteria.to = opts.to;
  if (opts.cc !== undefined) {
    searchCriteria.or = [{ cc: opts.cc }, { bcc: opts.cc }];
  }

  return client.withMailbox("INBOX", async (imap) => {
    const uids = (await imap.search(searchCriteria, { uid: true })) as number[];
    uids.sort((a, b) => b - a);
    const pageUids = uids.slice(0, limit);

    if (pageUids.length === 0) return [];

    const messages = await imap.fetchAll(
      pageUids,
      { envelope: true, flags: true },
      { uid: true },
    );

    return messages.map((msg) =>
      mapSummary(
        msg.uid as number,
        "INBOX",
        msg.envelope as ImapEnvelope,
        msg.flags as Set<string>,
      ),
    );
  });
}

export async function readEmail(
  clients: ImapClientFactory,
  account: AccountRecord,
  id: string,
): Promise<EmailFull> {
  const client = clients.get(account);
  const { folder, uid } = decodeId(id);

  return client.withMailbox(folder, async (imap) => {
    const msg = await imap.fetchOne(
      uid,
      { bodyStructure: true, envelope: true, flags: true },
      { uid: true },
    );

    if (!msg || !msg.envelope) {
      throw new Error(`message not found: ${id}`);
    }

    const envelope = msg.envelope as ImapEnvelope;
    const structure = msg.bodyStructure as BodyNode;
    const flags = (msg.flags as Set<string>) ?? new Set<string>();

    let bodyText: string | undefined;
    let bodyHtml: string | undefined;

    const textPart = findPartByType(structure, "text/plain");
    const htmlPart = findPartByType(structure, "text/html");

    if (textPart) {
      const { content } = await imap.download(uid, textPart, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of content as Readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      bodyText = Buffer.concat(chunks).toString("utf-8");
    }

    if (htmlPart) {
      const { content } = await imap.download(uid, htmlPart, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of content as Readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      bodyHtml = Buffer.concat(chunks).toString("utf-8");
    }

    const attachments: EmailFull["attachments"] = findAttachments(
      structure,
    ).map((a) => ({
      id: a.part,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
    }));

    const summary = mapSummary(uid, folder, envelope, flags);

    return {
      ...summary,
      cc: (envelope.cc ?? []).map(mapEnvelopeAddr),
      bcc: (envelope.bcc ?? []).map(mapEnvelopeAddr),
      bodyText,
      bodyHtml,
      attachments: attachments.length > 0 ? attachments : undefined,
      hasAttachments: attachments.length > 0,
    };
  });
}

export async function readAttachment(
  clients: ImapClientFactory,
  account: AccountRecord,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentContent> {
  const client = clients.get(account);
  const { folder, uid } = decodeId(messageId);

  return client.withMailbox(folder, async (imap) => {
    const msg = (await imap.fetchOne(
      uid,
      { bodyStructure: true },
      { uid: true },
    )) as { bodyStructure?: BodyNode } | false;

    let name = "attachment";
    let contentType: string | undefined;
    if (msg && msg.bodyStructure) {
      const attachments = findAttachments(msg.bodyStructure);
      const match = attachments.find((a) => a.part === attachmentId);
      if (match) {
        name = match.name;
        contentType = match.contentType;
      }
    }

    const { meta, content } = await imap.download(uid, attachmentId, {
      uid: true,
    });

    const outPath = await writeAttachmentFile(name, content as unknown as Readable);

    return {
      name,
      contentType: contentType ?? (meta as { contentType?: string }).contentType,
      path: outPath,
      webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
    };
  });
}

export async function listFolders(
  clients: ImapClientFactory,
  account: AccountRecord,
  opts: ListFoldersOptions,
): Promise<FolderInfo[]> {
  const client = clients.get(account);

  const mailboxes = await client.run((imap) =>
    imap.list({
      statusQuery: { messages: true, unseen: true, uidNext: true },
    } as never),
  );

  let results: FolderInfo[] = (
    mailboxes as unknown as ImapMailboxEntry[]
  ).map(mapMailboxToListEntry);

  if (opts.parentFolderId) {
    const parentPath = opts.parentFolderId;
    results = results.filter(
      (f) =>
        f.parentFolderId === parentPath ||
        (parentPath === "INBOX" && f.displayName === "INBOX"),
    );
  } else {
    // Top-level: filter out children of other folders
    const allPaths = new Set(results.map((f) => f.displayName));
    results = results.filter((f) => {
      const lastSep = f.displayName.lastIndexOf("/");
      if (lastSep === -1) return true;
      const parent = f.displayName.slice(0, lastSep);
      return !allPaths.has(parent);
    });
  }

  return results;
}
