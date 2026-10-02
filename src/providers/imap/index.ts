import type { AccountRecord, AccountStore } from "../../store/account-store.js";
import type { Logger } from "../../logger.js";
import { noopLogger } from "../../logger.js";
import type {
  AddAccountInput,
  AddAccountResult,
  AttachmentContent,
  CompleteAddAccountResult,
  CreateFolderInput,
  DraftUpdateInput,
  EmailFull,
  EmailReference,
  EmailProvider,
  EmailSummary,
  FolderInfo,
  ListEmailsOptions,
  ListEmailsResult,
  ListFoldersOptions,
  SearchEmailsOptions,
  SendInput,
} from "../types.js";
import { ImapClientFactory } from "./client.js";
import {
  listEmails,
  searchEmails,
  readEmail,
  readAttachment,
  listFolders,
} from "./read-ops.js";
import {
  addAccount,
  completeAddAccount,
} from "./account-ops.js";
import {
  sendEmail,
  saveDraft,
  updateDraft,
  moveEmail,
  trashEmail,
  sendDraft,
  addAttachmentToDraft,
  removeAttachmentsFromDraft,
  markRead,
} from "./write-ops.js";
import {
  createFolder,
  renameFolder,
  deleteFolder,
} from "./folders.js";

export class ImapProvider implements EmailProvider {
  readonly id = "imap" as const;
  private readonly clients: ImapClientFactory;

  constructor(
    private readonly store?: AccountStore,
    logger: Logger = noopLogger,
  ) {
    this.clients = new ImapClientFactory(logger);
  }

  // ---------- account lifecycle ----------

  async addAccount(input: AddAccountInput): Promise<AddAccountResult> {
    if (!this.store) throw new Error("IMAP provider requires an AccountStore");
    return addAccount(this.clients, this.store, input);
  }

  async completeAddAccount(_handle: string): Promise<CompleteAddAccountResult> {
    return completeAddAccount();
  }

  // ---------- browse ----------

  async listEmails(account: AccountRecord, opts: ListEmailsOptions): Promise<ListEmailsResult> {
    return listEmails(this.clients, account, opts);
  }

  async searchEmails(account: AccountRecord, opts: SearchEmailsOptions): Promise<EmailSummary[]> {
    return searchEmails(this.clients, account, opts);
  }

  async readEmail(account: AccountRecord, id: string): Promise<EmailFull> {
    return readEmail(this.clients, account, id);
  }

  async readAttachment(account: AccountRecord, messageId: string, attachmentId: string): Promise<AttachmentContent> {
    return readAttachment(this.clients, account, messageId, attachmentId);
  }

  // ---------- compose ----------

  async sendEmail(account: AccountRecord, msg: SendInput): Promise<EmailReference> {
    return sendEmail(this.clients, account, msg);
  }

  async saveDraft(account: AccountRecord, msg: SendInput): Promise<EmailReference> {
    return saveDraft(this.clients, account, msg);
  }

  async updateDraft(account: AccountRecord, id: string, update: DraftUpdateInput): Promise<EmailReference> {
    return updateDraft(this.clients, account, id, update);
  }

  async moveEmail(account: AccountRecord, id: string, destinationId: string): Promise<EmailReference> {
    return moveEmail(this.clients, account, id, destinationId);
  }

  async trashEmail(account: AccountRecord, id: string): Promise<EmailReference> {
    return trashEmail(this.clients, account, id);
  }

  async sendDraft(account: AccountRecord, id: string): Promise<EmailReference> {
    return sendDraft(this.clients, account, id);
  }

  async addAttachmentToDraft(
    account: AccountRecord,
    draftId: string,
    name: string,
    contentBytes: string,
    contentType?: string,
  ): Promise<{ id: string; attachment: { id: string; name: string; contentType?: string } }> {
    return addAttachmentToDraft(this.clients, account, draftId, name, contentBytes, contentType);
  }

  async removeAttachmentsFromDraft(
    account: AccountRecord,
    draftId: string,
    attachmentIds: string[],
  ): Promise<EmailReference> {
    return removeAttachmentsFromDraft(this.clients, account, draftId, attachmentIds);
  }

  // ---------- organize ----------

  async markRead(account: AccountRecord, id: string, isRead: boolean): Promise<EmailReference> {
    return markRead(this.clients, account, id, isRead);
  }

  // ---------- folders ----------

  async listFolders(account: AccountRecord, opts: ListFoldersOptions): Promise<FolderInfo[]> {
    return listFolders(this.clients, account, opts);
  }

  async createFolder(account: AccountRecord, input: CreateFolderInput): Promise<FolderInfo> {
    return createFolder(this.clients, account, input);
  }

  async renameFolder(account: AccountRecord, folderId: string, newName: string): Promise<FolderInfo> {
    return renameFolder(this.clients, account, folderId, newName);
  }

  async deleteFolder(account: AccountRecord, folderId: string): Promise<void> {
    return deleteFolder(this.clients, account, folderId);
  }
}
