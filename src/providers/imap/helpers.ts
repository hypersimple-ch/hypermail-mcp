import type { EmailAddress, EmailSummary, FolderInfo } from "../types.js";
import type { AccountRecord } from "../../store/account-store.js";

// ---------- well-known folder mapping ----------

const WELL_KNOWN_TO_IMAP: Record<string, string> = {
  archive: "Archive",
  deleteditems: "Trash",
  inbox: "INBOX",
  drafts: "Drafts",
  sentitems: "Sent",
  junkemail: "Junk",
  outbox: "Outbox",
};

export function resolveFolder(wellKnownOrPath: string): string {
  return WELL_KNOWN_TO_IMAP[wellKnownOrPath.toLowerCase()] ?? wellKnownOrPath;
}

export function isTrashFolderAlias(wellKnownOrPath: string): boolean {
  const lower = wellKnownOrPath.toLowerCase();
  return lower === "deleteditems" || lower === "trash";
}

export function resolveTrashMailbox(
  mailboxes: Iterable<ImapMailboxEntry>,
): string {
  for (const mailbox of mailboxes) {
    const specialUse = mailbox.specialUse?.toLowerCase();
    if (specialUse === "\\trash") return mailbox.path;

    const flags = mailbox.flags ? Array.from(mailbox.flags) : [];
    if (flags.some((flag) => flag.toLowerCase() === "\\trash")) {
      return mailbox.path;
    }
  }
  return "Trash";
}

/** Gmail advertises All Mail as \All, not as a separate archive folder. */
export function resolveArchiveMailbox(
  mailboxes: Iterable<ImapMailboxEntry>,
): string {
  let archivePath: string | undefined;
  for (const mailbox of mailboxes) {
    const specialUse = mailbox.specialUse?.toLowerCase();
    const flags = mailbox.flags ? Array.from(mailbox.flags) : [];
    if (specialUse === "\\all" || flags.some((flag) => flag.toLowerCase() === "\\all")) {
      return mailbox.path;
    }
    if (specialUse === "\\archive" || flags.some((flag) => flag.toLowerCase() === "\\archive")) {
      archivePath ??= mailbox.path;
    }
  }
  return archivePath ?? "Archive";
}

export function resolveDraftMailbox(
  mailboxes: Iterable<ImapMailboxEntry>,
): string {
  for (const mailbox of mailboxes) {
    const specialUse = mailbox.specialUse?.toLowerCase();
    if (specialUse === "\\drafts") return mailbox.path;

    const flags = mailbox.flags ? Array.from(mailbox.flags) : [];
    if (flags.some((flag) => flag.toLowerCase() === "\\drafts")) {
      return mailbox.path;
    }
  }
  return "Drafts";
}

// ---------- generic ----------

/** Generic IMAP does not expose a provider-native web client URL. */
export const IMAP_WEB_URL_UNAVAILABLE_REASON =
  "Web links are unavailable for generic IMAP accounts.";

export function webLinkUnavailableReference(id: string) {
  return { id, webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON };
}

export function clampLimit(v: number | undefined, dflt: number, max: number): number {
  if (!v || v <= 0) return dflt;
  return Math.min(v, max);
}

// ---------- ID encoding ----------

/** Encode a folder path + numeric UID into a composite message ID. */
export function encodeId(folder: string, uid: number): string {
  return `${folder}/${uid}`;
}

/** Decode a composite message ID back into folder + numeric UID. */
export function decodeId(id: string): { folder: string; uid: number } {
  const idx = id.lastIndexOf("/");
  if (idx === -1) throw new Error(`invalid message ID: ${id}`);
  const folder = id.slice(0, idx);
  const uid = Number(id.slice(idx + 1));
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error(`invalid message UID in ID: ${id}`);
  }
  return { folder, uid };
}

// ---------- body structure helpers ----------

export interface BodyNode {
  type?: string;
  part?: string;
  encoding?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: BodyNode[];
}

export interface ImapAttachmentMeta {
  part: string;
  name: string;
  contentType?: string;
  size?: number;
}

/** Recursively collect attachment metadata from a bodyStructure node. */
export function findAttachments(node: BodyNode): ImapAttachmentMeta[] {
  const attachments: ImapAttachmentMeta[] = [];
  const topType = (node.type ?? "").split("/")[0];

  const isAttachment =
    node.disposition === "attachment" ||
    (!!node.type &&
      topType !== "text" &&
      topType !== "multipart" &&
      !node.disposition);

  if (isAttachment) {
    attachments.push({
      part: node.part ?? "1",
      name:
        node.dispositionParameters?.filename ??
        node.parameters?.name ??
        "attachment",
      contentType: node.type,
      size: node.size,
    });
  }

  if (node.childNodes) {
    for (const child of node.childNodes) {
      attachments.push(...findAttachments(child));
    }
  }

  return attachments;
}

/**
 * Find the part number for a specific content type (e.g. "text/plain",
 * "text/html") in the body structure tree.
 */
export function findPartByType(
  node: BodyNode,
  contentType: string,
): string | undefined {
  if (node.type === contentType) return node.part ?? "1";
  if (node.childNodes) {
    for (const child of node.childNodes) {
      const found = findPartByType(child, contentType);
      if (found) return found;
    }
  }
  return undefined;
}

// ---------- envelope mapping ----------

export interface ImapEnvelopeAddr {
  name?: string;
  address?: string;
}

export interface ImapEnvelope {
  subject?: string;
  date?: Date;
  messageId?: string;
  inReplyTo?: string;
  from?: ImapEnvelopeAddr[];
  to?: ImapEnvelopeAddr[];
  cc?: ImapEnvelopeAddr[];
  bcc?: ImapEnvelopeAddr[];
}

export function mapEnvelopeAddr(a: ImapEnvelopeAddr): EmailAddress {
  return { name: a.name, address: a.address ?? "" };
}

export function mapSummary(
  uid: number,
  folder: string,
  envelope: ImapEnvelope,
  flags: Set<string> = new Set(),
): EmailSummary {
  const fromAddr =
    envelope.from && envelope.from.length > 0 && envelope.from[0]
      ? mapEnvelopeAddr(envelope.from[0])
      : undefined;
  return {
    id: encodeId(folder, uid),
    subject: envelope.subject ?? "",
    from: fromAddr,
    to: (envelope.to ?? []).map(mapEnvelopeAddr),
    receivedAt: envelope.date ? envelope.date.toISOString() : undefined,
    isRead: flags.has("\\Seen"),
    folder,
    webUrlUnavailableReason: IMAP_WEB_URL_UNAVAILABLE_REASON,
  };
}

// ---------- mailbox mapping ----------

export interface ImapMailboxEntry {
  path: string;
  name?: string;
  specialUse?: string;
  flags?: Set<string> | string[];
  delimiter?: string;
  listed?: boolean;
  subscribed?: boolean;
  status?: {
    messages?: number;
    unseen?: number;
  };
}

export function mapMailboxToListEntry(m: ImapMailboxEntry): FolderInfo {
  const lastSep = m.path.lastIndexOf("/");
  const parentFolderId =
    lastSep === -1 ? undefined : m.path.slice(0, lastSep);
  return {
    id: m.path,
    displayName: m.path,
    parentFolderId,
    childFolderCount: 0,
    totalItemCount: m.status?.messages ?? 0,
    unreadItemCount: m.status?.unseen ?? 0,
  };
}
