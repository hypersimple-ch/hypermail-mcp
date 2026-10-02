import { randomUUID } from "node:crypto";
import type { AccountRecord, AccountStore } from "../../store/account-store.js";
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
import { OutlookClientFactory } from "./client.js";
import {
  awaitDeviceCodeReady,
  beginDeviceCode,
  type DeviceCodeBegin,
} from "./auth.js";
import { convertInlineImages } from "./helpers.js";
import {
  addAttachmentToDraft,
  markRead,
  moveEmail,
  removeAttachmentsFromDraft,
  sendDraft,
  sendOrSave,
  updateDraft,
} from "./write-ops.js";
import {
  listEmails,
  readAttachment,
  readEmail,
  searchEmails,
} from "./read-ops.js";
import {
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
} from "./folders.js";

export { convertInlineImages };

interface PendingFlow {
  begin: DeviceCodeBegin;
  emailHint?: string;
  startedAt: number;
  settled: "pending" | "ready" | "error" | "expired";
  account?: AccountRecord;
  error?: string;
}

export interface OutlookProviderOptions {
  store: AccountStore;
  clientId?: string;
  tenantId?: string;
}

export class OutlookProvider implements EmailProvider {
  readonly id = "outlook" as const;
  private readonly clients: OutlookClientFactory;
  private readonly pending = new Map<string, PendingFlow>();
  private readonly clientId?: string;
  private readonly tenantId?: string;

  constructor(private readonly opts: OutlookProviderOptions) {
    this.clientId = opts.clientId;
    this.tenantId = opts.tenantId;
    this.clients = new OutlookClientFactory(opts.store, opts.clientId, opts.tenantId);
  }

  // ---------- account lifecycle ----------

  async addAccount(input: AddAccountInput): Promise<AddAccountResult> {
    const begin = beginDeviceCode(undefined, this.clientId, this.tenantId);
    await awaitDeviceCodeReady(begin);

    const handle = randomUUID();
    const flow: PendingFlow = {
      begin,
      emailHint: input.email,
      startedAt: Date.now(),
      settled: "pending",
    };
    this.pending.set(handle, flow);

    // Fire-and-forget: when the user finishes, persist and update flow.
    begin.result
      .then(async ({ tokens, account }) => {
        const email = (account.username || input.email || "").toLowerCase();
        if (!email) {
          flow.settled = "error";
          flow.error = "no email returned from Microsoft account";
          return;
        }
        const rec: AccountRecord = {
          email,
          provider: "outlook",
          displayName: account.name ?? undefined,
          tokens: tokens as unknown as Record<string, unknown>,
          addedAt: new Date().toISOString(),
        };
        const saved = await this.opts.store.upsertAccount(rec);
        flow.account = saved;
        flow.settled = "ready";
      })
      .catch((err: unknown) => {
        flow.settled = "error";
        flow.error = err instanceof Error ? err.message : String(err);
      });

    return {
      status: "pending",
      handle,
      verification: {
        userCode: begin.userCode,
        verificationUri: begin.verificationUri,
        expiresAt: begin.expiresAt,
        message: begin.message,
      },
    };
  }

  async completeAddAccount(handle: string): Promise<CompleteAddAccountResult> {
    const flow = this.pending.get(handle);
    if (!flow) return { status: "error", error: "unknown handle" };
    // expire after 20 minutes regardless
    if (Date.now() - flow.startedAt > 20 * 60_000 && flow.settled === "pending") {
      flow.settled = "expired";
      flow.begin.cancel();
    }
    if (flow.settled === "ready" && flow.account) {
      this.pending.delete(handle);
      return { status: "ready", account: flow.account };
    }
    if (flow.settled === "error") {
      this.pending.delete(handle);
      return { status: "error", error: flow.error ?? "unknown error" };
    }
    if (flow.settled === "expired") {
      this.pending.delete(handle);
      return { status: "expired" };
    }
    return { status: "pending" };
  }

  // ---------- email ops (delegated) ----------

  async listEmails(account: AccountRecord, opts: ListEmailsOptions): Promise<ListEmailsResult> {
    return listEmails(this.clients.get(account), account, opts);
  }

  async searchEmails(
    account: AccountRecord,
    opts: SearchEmailsOptions,
  ): Promise<EmailSummary[]> {
    return searchEmails(this.clients.get(account), account, opts);
  }

  async readEmail(account: AccountRecord, id: string): Promise<EmailFull> {
    return readEmail(this.clients.get(account), account, id);
  }

  async readAttachment(
    account: AccountRecord,
    messageId: string,
    attachmentId: string,
  ): Promise<AttachmentContent> {
    return readAttachment(this.clients.get(account), account, messageId, attachmentId);
  }

  async sendEmail(account: AccountRecord, msg: SendInput): Promise<EmailReference> {
    return sendOrSave(this.clients.get(account), account, msg, "send");
  }

  async saveDraft(account: AccountRecord, msg: SendInput): Promise<EmailReference> {
    return sendOrSave(this.clients.get(account), account, msg, "draft");
  }

  async updateDraft(
    account: AccountRecord,
    id: string,
    update: DraftUpdateInput,
  ): Promise<EmailReference> {
    return updateDraft(this.clients.get(account), account, id, update);
  }

  async moveEmail(account: AccountRecord, id: string, destinationId: string): Promise<EmailReference> {
    return moveEmail(this.clients.get(account), account, id, destinationId);
  }

  async trashEmail(account: AccountRecord, id: string): Promise<EmailReference> {
    return moveEmail(this.clients.get(account), account, id, "deleteditems");
  }

  async sendDraft(account: AccountRecord, id: string): Promise<EmailReference> {
    return sendDraft(this.clients.get(account), account, id);
  }

  async addAttachmentToDraft(
    account: AccountRecord,
    draftId: string,
    name: string,
    contentBytes: string,
    contentType?: string,
  ): Promise<{ id: string; attachment: { id: string; name: string; contentType?: string } }> {
    return addAttachmentToDraft(
      this.clients.get(account),
      account,
      draftId,
      name,
      contentBytes,
      contentType,
    );
  }

  async removeAttachmentsFromDraft(
    account: AccountRecord,
    draftId: string,
    attachmentIds: string[],
  ): Promise<EmailReference> {
    return removeAttachmentsFromDraft(this.clients.get(account), account, draftId, attachmentIds);
  }

  async markRead(account: AccountRecord, id: string, isRead: boolean): Promise<EmailReference> {
    return markRead(this.clients.get(account), account, id, isRead);
  }

  // ---------- folder ops (delegated) ----------

  async listFolders(account: AccountRecord, opts: ListFoldersOptions): Promise<FolderInfo[]> {
    return listFolders(this.clients.get(account), account, opts);
  }

  async createFolder(account: AccountRecord, input: CreateFolderInput): Promise<FolderInfo> {
    return createFolder(this.clients.get(account), account, input);
  }

  async renameFolder(
    account: AccountRecord,
    folderId: string,
    newName: string,
  ): Promise<FolderInfo> {
    return renameFolder(this.clients.get(account), account, folderId, newName);
  }

  async deleteFolder(account: AccountRecord, folderId: string): Promise<void> {
    return deleteFolder(this.clients.get(account), account, folderId);
  }
}
