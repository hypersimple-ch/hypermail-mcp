import { randomUUID } from "node:crypto";

import type { AccountStore, AccountRecord } from "../../store/account-store.js";
import type {
  AddAccountInput,
  AddAccountResult,
  AttachmentContent,
  CompleteAddAccountInput,
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
import {
  beginAuthorizationCode,
  completeAuthorizationCode,
  type AuthorizationCodeBegin,
  type SerializedGmailTokens,
} from "./auth.js";
import { GmailClientFactory } from "./client.js";
import {
  listEmails,
  searchEmails,
  readEmail,
  readAttachment,
  listFolders,
} from "./read-ops.js";
import {
  sendEmail,
  saveDraft,
  updateDraft,
  moveEmail,
  trashEmail,
  sendDraft,
  addAttachmentToDraft,
  removeAttachmentFromDraft,
  markRead,
  createFolder,
  renameFolder,
  deleteFolder,
} from "./write-ops.js";

// ── pending flow (mirrors Outlook's PendingFlow pattern) ──

interface PendingFlow {
  begin: AuthorizationCodeBegin;
  emailHint?: string;
  startedAt: number;
  settled: "pending" | "ready" | "error" | "expired";
  account?: AccountRecord;
  error?: string;
}

// ── provider ──

export interface GmailProviderOptions {
  store: AccountStore;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export class GmailProvider implements EmailProvider {
  readonly id = "gmail" as const;
  private readonly clients: GmailClientFactory;
  private readonly pending = new Map<string, PendingFlow>();
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly redirectUri?: string;

  constructor(private readonly opts: GmailProviderOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.redirectUri = opts.redirectUri;
    this.clients = new GmailClientFactory(
      opts.store,
      opts.clientId,
      opts.clientSecret,
    );
  }

  // ── account lifecycle ──

  async addAccount(input: AddAccountInput): Promise<AddAccountResult> {
    const begin = await beginAuthorizationCode({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      loginHint: input.email,
    });

    const handle = randomUUID();
    const flow: PendingFlow = {
      begin,
      emailHint: input.email,
      startedAt: Date.now(),
      settled: "pending",
    };
    this.pending.set(handle, flow);

    return {
      status: "pending",
      handle,
      verification: {
        type: "oauth_url",
        userCode: begin.userCode,
        verificationUri: begin.verificationUri,
        expiresAt: begin.expiresAt,
        message: begin.message,
      },
    };
  }

  async completeAddAccount(
    handle: string,
    input: CompleteAddAccountInput = {},
  ): Promise<CompleteAddAccountResult> {
    const flow = this.pending.get(handle);
    if (!flow) return { status: "error", error: "unknown handle" };
    if (
      Date.now() - flow.startedAt > 20 * 60_000 &&
      flow.settled === "pending"
    ) {
      flow.settled = "expired";
      flow.begin.cancel();
    }
    if (flow.settled === "ready" && flow.account) {
      this.pending.delete(handle);
      flow.begin.cancel();
      return { status: "ready", account: flow.account };
    }
    if (flow.settled === "error") {
      this.pending.delete(handle);
      flow.begin.cancel();
      return { status: "error", error: flow.error ?? "unknown error" };
    }
    if (flow.settled === "expired") {
      this.pending.delete(handle);
      flow.begin.cancel();
      return { status: "expired" };
    }

    let completionInput = input;
    if (!completionInput.authorizationResponse && !completionInput.code) {
      const captured = flow.begin.consumeAuthorizationResponse();
      if (!captured) return { status: "pending" };
      completionInput = captured;
    }

    try {
      const { tokens, email } = await completeAuthorizationCode(flow.begin, completionInput);
      const resolvedEmail = (email || flow.emailHint || "").toLowerCase();
      if (!resolvedEmail) {
        throw new Error("no email returned from Google account");
      }
      const rec: AccountRecord = {
        email: resolvedEmail,
        provider: "gmail",
        displayName: resolvedEmail,
        tokens: tokens as unknown as Record<string, unknown>,
        addedAt: new Date().toISOString(),
      };
      const saved = await this.opts.store.upsertAccount(rec);
      this.clients.invalidate(saved.email);
      this.pending.delete(handle);
      flow.begin.cancel();
      return { status: "ready", account: saved };
    } catch (err) {
      this.pending.delete(handle);
      flow.begin.cancel();
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async completeAddAccountFromRedirect(
    authorizationResponse: string,
  ): Promise<CompleteAddAccountResult> {
    let state: string | null;
    try {
      state = new URL(authorizationResponse).searchParams.get("state");
    } catch {
      return { status: "error", error: "authorizationResponse must be a full redirected URL" };
    }
    if (!state) {
      return { status: "error", error: "authorizationResponse is missing OAuth state" };
    }

    for (const [handle, flow] of this.pending) {
      if (flow.begin.state === state) {
        return this.completeAddAccount(handle, { authorizationResponse });
      }
    }
    return { status: "error", error: "unknown OAuth state — restart Gmail account setup" };
  }

  // ── browse ──

  async listEmails(
    account: AccountRecord,
    opts: ListEmailsOptions,
  ): Promise<ListEmailsResult> {
    return listEmails(this.clients, account, opts);
  }

  async searchEmails(
    account: AccountRecord,
    opts: SearchEmailsOptions,
  ): Promise<EmailSummary[]> {
    return searchEmails(this.clients, account, opts);
  }

  async readEmail(account: AccountRecord, id: string): Promise<EmailFull> {
    return readEmail(this.clients, account, id);
  }

  async readAttachment(
    account: AccountRecord,
    messageId: string,
    attachmentId: string,
  ): Promise<AttachmentContent> {
    return readAttachment(this.clients, account, messageId, attachmentId);
  }

  // ── compose ──

  async sendEmail(
    account: AccountRecord,
    msg: SendInput,
  ): Promise<EmailReference> {
    return sendEmail(this.clients, account, msg);
  }

  async saveDraft(
    account: AccountRecord,
    msg: SendInput,
  ): Promise<EmailReference> {
    return saveDraft(this.clients, account, msg);
  }

  async updateDraft(
    account: AccountRecord,
    id: string,
    update: DraftUpdateInput,
  ): Promise<EmailReference> {
    return updateDraft(this.clients, account, id, update);
  }

  async moveEmail(
    account: AccountRecord,
    id: string,
    destinationId: string,
  ): Promise<EmailReference> {
    return moveEmail(this.clients, account, id, destinationId);
  }

  async trashEmail(
    account: AccountRecord,
    id: string,
  ): Promise<EmailReference> {
    return trashEmail(this.clients, account, id);
  }

  async sendDraft(
    account: AccountRecord,
    id: string,
  ): Promise<EmailReference> {
    return sendDraft(this.clients, account, id);
  }

  async addAttachmentToDraft(
    account: AccountRecord,
    draftId: string,
    name: string,
    contentBytes: string,
    contentType?: string,
  ): Promise<{
    id: string;
    attachment: { id: string; name: string; contentType?: string };
  }> {
    return addAttachmentToDraft(
      this.clients,
      account,
      draftId,
      name,
      contentBytes,
      contentType,
    );
  }

  async removeAttachmentFromDraft(
    account: AccountRecord,
    draftId: string,
    attachmentId: string,
  ): Promise<void> {
    return removeAttachmentFromDraft(this.clients, account, draftId, attachmentId);
  }

  // ── organize ──

  async markRead(
    account: AccountRecord,
    id: string,
    isRead: boolean,
  ): Promise<EmailReference> {
    return markRead(this.clients, account, id, isRead);
  }

  // ── folders ──

  async listFolders(
    account: AccountRecord,
    opts: ListFoldersOptions,
  ): Promise<FolderInfo[]> {
    return listFolders(this.clients, account, opts);
  }

  async createFolder(
    account: AccountRecord,
    input: CreateFolderInput,
  ): Promise<FolderInfo> {
    return createFolder(this.clients, account, input);
  }

  async renameFolder(
    account: AccountRecord,
    folderId: string,
    newName: string,
  ): Promise<FolderInfo> {
    return renameFolder(this.clients, account, folderId, newName);
  }

  async deleteFolder(
    account: AccountRecord,
    folderId: string,
  ): Promise<void> {
    return deleteFolder(this.clients, account, folderId);
  }
}
