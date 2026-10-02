import type { AccountRecord } from "../store/account-store.js";

export type ProviderId = "outlook" | "imap" | "gmail";

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailWebLinkFields {
  /** Shareable URL for opening the message in the provider's native web client. */
  webUrl?: string;
  /** Best-effort explanation when the provider cannot supply a native web URL. */
  webUrlUnavailableReason?: string;
}

export interface EmailReference extends EmailWebLinkFields {
  id: string;
}

export interface EmailSummary extends EmailWebLinkFields {
  id: string;
  subject: string;
  from?: EmailAddress;
  to?: EmailAddress[];
  receivedAt?: string; // ISO
  preview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  folder?: string;
  /** True when a provider search result points at an item that cannot be read anymore. */
  stale?: boolean;
}

export interface EmailFull extends EmailSummary {
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  bodyText?: string;
  bodyHtml?: string;
  attachments?: Array<{
    id: string;
    name: string;
    contentType?: string;
    size?: number;
  }>;
}

export interface ListEmailsOptions {
  folder?: string;
  limit?: number;
  unreadOnly?: boolean;
  /** Number of items to skip for pagination (offset-based). Defaults to 0. */
  skip?: number;
}

/** Paginated result from `listEmails`. */
export interface ListEmailsResult {
  items: EmailSummary[];
  hasMore: boolean;
}

export interface SearchEmailsOptions {
  query?: string;
  from?: string;
  to?: string;
  /** Search both CC and BCC recipients. */
  cc?: string;
  limit?: number;
}

export interface SendInput {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: string;
  isHtml?: boolean;
  /** ID of the message being replied to. When set, the message is sent as a
   *  reply (or reply-all if `replyAll` is true), preserving thread history.
   *  Set to `false` for a new email (not a reply). */
  inReplyTo: string | false;
  /** When true and `inReplyTo` is set, reply to all recipients instead of just
   *  the sender. Defaults to false. */
  replyAll?: boolean;
  /** ID of the message to forward. When set, the message is sent as a forward
   *  of the specified message, preserving the original content. Mutually
   *  exclusive with `inReplyTo`. */
  forwardMessageId?: string;
  /** Optional file attachments to include with the message.
   *  Each attachment must be base64-encoded. */
  attachments?: Array<{
    name: string;
    contentBytes: string;
    contentType?: string;
  }>;
}

/**
 * Fields that can be updated on an existing draft. All fields are optional —
 * only the ones provided will be patched. `inReplyTo` / `replyAll` /
 * `forwardMessageId` are excluded because they are set at creation time and
 * cannot be changed on an existing draft.
 */
export interface DraftUpdateInput {
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject?: string;
  body?: string;
  isHtml?: boolean;
}

/**
 * Result of starting an add-account flow.
 *
 * - `pending` (e.g. device code): the caller must show `verification` to the
 *   user and later poll via `complete_add_account` with `handle`.
 * - `ready`: the account is fully provisioned and persisted.
 */
export type AddAccountResult =
  | {
      status: "pending";
      handle: string;
      verification: {
        type?: "device_code" | "oauth_url";
        userCode: string;
        verificationUri: string;
        expiresAt: string; // ISO
        message: string;
      };
    }
  | { status: "ready"; account: AccountRecord };

export interface AddAccountInput {
  /** Optional hint — the provider may infer/verify this from the auth result. */
  email?: string;
  /** Provider-specific extras (e.g. IMAP host/port/password) */
  config?: Record<string, unknown>;
}

export interface CompleteAddAccountInput {
  /** Full redirected URL copied from the browser after OAuth consent. */
  authorizationResponse?: string;
  /** Raw authorization code, for clients that extract it themselves. */
  code?: string;
  /** OAuth state returned alongside the raw authorization code. */
  state?: string;
}

export interface CompleteAddAccountResult {
  status: "pending" | "ready" | "expired" | "error";
  account?: AccountRecord;
  error?: string;
}

export interface AttachmentInput {
  /** Filename for the attachment (e.g., 'report.pdf') */
  name: string;
  /** Base64-encoded file content */
  contentBytes: string;
  /** MIME type (e.g., 'application/pdf'). Inferred from file extension if omitted. */
  contentType?: string;
}

export interface AttachmentContent extends EmailWebLinkFields {
  name: string;
  contentType?: string;
  path: string;
}

export interface FolderInfo {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount: number;
  totalItemCount: number;
  unreadItemCount: number;
}

export interface ListFoldersOptions {
  /** When provided, lists child folders of this folder. When omitted, lists
   *  top-level folders (children of the root). */
  parentFolderId?: string;
}

export interface CreateFolderInput {
  displayName: string;
  /** When provided, creates the folder as a child of this parent. When
   *  omitted, creates under the root folder. */
  parentFolderId?: string;
}

export interface EmailProvider {
  readonly id: ProviderId;

  addAccount(input: AddAccountInput): Promise<AddAccountResult>;
  /** Optional — only providers with async/manual flows need this. */
  completeAddAccount?(
    handle: string,
    input?: CompleteAddAccountInput,
  ): Promise<CompleteAddAccountResult>;
  /** Optional — providers with HTTP OAuth callbacks can complete by redirected URL. */
  completeAddAccountFromRedirect?(
    authorizationResponse: string,
  ): Promise<CompleteAddAccountResult>;

  listEmails(account: AccountRecord, opts: ListEmailsOptions): Promise<ListEmailsResult>;
  searchEmails(
    account: AccountRecord,
    opts: SearchEmailsOptions,
  ): Promise<EmailSummary[]>;
  readEmail(account: AccountRecord, id: string): Promise<EmailFull>;
  readAttachment(
    account: AccountRecord,
    messageId: string,
    attachmentId: string,
  ): Promise<AttachmentContent>;
  sendEmail(account: AccountRecord, msg: SendInput): Promise<EmailReference>;
  /**
   * Create a draft message from the given input without sending it.
   * Returns the draft message ID so the caller can later find it in the
   * Drafts folder, open it for further editing, or send it manually.
   */
  saveDraft(account: AccountRecord, msg: SendInput): Promise<EmailReference>;
  /**
   * Update an existing draft message by ID. Only the fields present in
   * `update` are patched — the rest are left unchanged.
   * Returns the draft message ID.
   */
  updateDraft(
    account: AccountRecord,
    id: string,
    update: DraftUpdateInput,
  ): Promise<EmailReference>;
  /**
   * Move a message to another folder.
   * `destinationId` can be a well-known folder name (e.g. "archive",
   * "deleteditems", "inbox") or a custom folder ID.
   */
  moveEmail(
    account: AccountRecord,
    id: string,
    destinationId: string,
  ): Promise<EmailReference>;
  /** Move a message to the provider-native trash/deleted-items location. */
  trashEmail(account: AccountRecord, id: string): Promise<EmailReference>;
  /**
   * Send an existing draft message by ID.
   * Returns the message ID.
   */
  sendDraft(account: AccountRecord, id: string): Promise<EmailReference>;
  /**
   * Add a file attachment to an existing draft message.
   * `contentBytes` must be base64-encoded file content.
   * Returns the draft ID and the created attachment metadata.
   */
  addAttachmentToDraft(
    account: AccountRecord,
    draftId: string,
    name: string,
    contentBytes: string,
    contentType?: string,
  ): Promise<{ id: string; attachment: { id: string; name: string; contentType?: string } }>;

  /**
   * Remove selected file attachments in one draft replacement.
   */
  removeAttachmentsFromDraft(
    account: AccountRecord,
    draftId: string,
    attachmentIds: string[],
  ): Promise<EmailReference>;

  /** Mark a message as read (isRead=true) or unread (isRead=false). */
  markRead(
    account: AccountRecord,
    id: string,
    isRead: boolean,
  ): Promise<EmailReference>;

  /** List mail folders. When parentFolderId is omitted, lists top-level
   *  folders (children of the root). */
  listFolders(account: AccountRecord, opts: ListFoldersOptions): Promise<FolderInfo[]>;

  /** Create a new mail folder. When parentFolderId is omitted, creates
   *  under the root folder. Returns the created folder. */
  createFolder(account: AccountRecord, input: CreateFolderInput): Promise<FolderInfo>;

  /** Rename an existing mail folder. Returns the updated folder. */
  renameFolder(account: AccountRecord, folderId: string, newName: string): Promise<FolderInfo>;

  /** Delete a mail folder by ID. */
  deleteFolder(account: AccountRecord, folderId: string): Promise<void>;
}
