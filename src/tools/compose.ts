import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import type { AccountRecord, AccountStore } from "../store/account-store.js";
import type { Registry } from "../providers/registry.js";
import type { EmailProvider, EmailReference, SendInput } from "../providers/types.js";
import type { ResolvedTools } from "../config.js";
import type { Logger } from "../logger.js";
import { MIME_TYPES } from "./mime-types.js";
import {
  ok,
  fail,
  errMsg,
  composeBody,
  shouldRegister,
  applyExactTextEdit,
  emailReferenceOutputSchema,
} from "./shared.js";
import {
  type BodyEditExpectation,
  readDraftWithVerifiedBody,
} from "./edit-draft-verify.js";
import {
  editDraftSchema,
  type EditDraftArgs,
  sendEmailSchema,
  type SendEmailArgs,
} from "./compose-schemas.js";

export function registerComposeTools(
  server: McpServer,
  ctx: {
    store: AccountStore;
    registry: Registry;
    tools: ResolvedTools;
    logger?: Logger;
  },
): void {
  const { store, registry, tools, logger } = ctx;

  async function handleSendOrDraft(
    args: SendEmailArgs,
    action: (
      provider: EmailProvider,
      account: AccountRecord,
      msg: SendInput,
    ) => Promise<EmailReference>,
    resultKey: string,
    toolName: string,
  ) {
    try {
      const { provider, account } = registry.resolveByEmail(args.account);
      logger?.debug("compose", "start", {
        tool: toolName,
        account: account.email,
        provider: provider.id,
        toCount: args.to.length,
        ccCount: args.cc?.length ?? 0,
        bccCount: args.bcc?.length ?? 0,
        hasReply: !!args.inReplyTo,
        hasForward: !!args.forwardMessageId,
        attachmentCount: args.attachments?.length ?? 0,
      });
      if (args.include_signature && !account.signature) {
        return fail(
          "include_signature is true but no signature is configured for this account. " +
            "Set up a signature first with set_account_settings.",
        );
      }
      const composed = composeBody({
        body: args.body,
        format: args.format,
        signature: account.signature,
        style: account.style,
        includeSignature: args.include_signature,
      });
      logger?.debug("compose", "composed", {
        tool: toolName,
        account: account.email,
        provider: provider.id,
        format: args.format,
        isHtml: composed.isHtml,
        includeSignature: args.include_signature,
      });
      if (args.inReplyTo && args.forwardMessageId) {
        return fail(
          "inReplyTo and forwardMessageId are mutually exclusive — use one or the other",
        );
      }

      // Process file attachments: read + encode each file
      let processedAttachments: SendInput["attachments"] = undefined;
      if (args.attachments && args.attachments.length > 0) {
        processedAttachments = args.attachments.map((att) => {
          const fileData = readFileSync(att.filePath);
          const ext = extname(att.filePath).toLowerCase();
          return {
            name: att.name ?? basename(att.filePath),
            contentBytes: fileData.toString("base64"),
            contentType: MIME_TYPES[ext] ?? "application/octet-stream",
          };
        });
      }
      logger?.debug("compose", "attachmentsProcessed", {
        tool: toolName,
        account: account.email,
        provider: provider.id,
        attachmentCount: processedAttachments?.length ?? 0,
      });

      const res = await action(provider, account, {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: composed.body,
        isHtml: composed.isHtml,
        inReplyTo: args.inReplyTo,
        replyAll: args.replyAll,
        forwardMessageId: args.forwardMessageId,
        attachments: processedAttachments,
      });
      logger?.debug("compose", "providerActionSuccess", {
        tool: toolName,
        account: account.email,
        provider: provider.id,
        hasId: !!res.id,
      });
      const result: Record<string, unknown> = { [resultKey]: true, ...res };
      if (toolName === "draft_email" && res.id) {
        try {
          const draft = await provider.readEmail(account, res.id);
          // Readback is the authoritative representation of the saved draft.
          // Its link may differ from the mutation response after provider-side moves.
          result.id = draft.id;
          delete result.webUrl;
          delete result.webUrlUnavailableReason;
          if (draft.webUrl !== undefined) result.webUrl = draft.webUrl;
          if (draft.webUrlUnavailableReason !== undefined) {
            result.webUrlUnavailableReason = draft.webUrlUnavailableReason;
          }
          result.draftHtml = draft.bodyHtml;
          logger?.debug("compose", "draftReadbackSuccess", {
            tool: toolName,
            account: account.email,
            provider: provider.id,
            hasDraftHtml: draft.bodyHtml !== undefined,
          });
        } catch (readErr) {
          const message = errMsg(readErr);
          result.warning =
            "Draft was created, but reading it back for draftHtml failed. " +
            "Use read_email with the returned id to inspect it, or continue with send_draft if appropriate.";
          result.draftReadbackError = message;
          logger?.debug("compose", "draftReadbackError", {
            tool: toolName,
            account: account.email,
            provider: provider.id,
            message,
          });
        }
      }
      return ok(result, result);
    } catch (err) {
      logger?.debug("compose", "error", {
        tool: toolName,
        account: args.account,
        message: errMsg(err),
      });
      return fail(errMsg(err));
    }
  }

  // ---------- send_email ----------

  const sendEmailOutputSchema = {
    sent: z.literal(true),
    ...emailReferenceOutputSchema.shape,
  };

  if (shouldRegister("send_email", tools)) {
    server.registerTool(
      "send_email",
      {
        description:
          "Send an email from the given account. Appends the " +
          "account's signature (HTML) and applies style preferences when " +
          "`include_signature` is true. Returns an error if " +
          "`include_signature` is true but no signature is configured. " +
          "When `inReplyTo` is set, sends as a reply (or reply-all) which " +
          "preserves thread history and conversation threading. " +
          "When `forwardMessageId` is set, sends as a forward of the " +
          "specified message, preserving the original content. " +
          "`inReplyTo` and `forwardMessageId` are mutually exclusive. " +
          "Returns the resulting message's shareable `webUrl` when available; " +
          "recipients must have access to the mailbox to open it.",
        inputSchema: sendEmailSchema,
        outputSchema: sendEmailOutputSchema,
      },
      async (args) =>
        handleSendOrDraft(
          args as SendEmailArgs,
          (p, a, m) => p.sendEmail(a, m),
          "sent",
          "send_email",
        ),
    );
  }

  // ---------- draft_email ----------

  const draftEmailOutputSchema = {
    draft: z.literal(true),
    ...emailReferenceOutputSchema.shape,
    draftHtml: z.string().optional(),
    warning: z.string().optional(),
    draftReadbackError: z.string().optional(),
  };

  if (shouldRegister("draft_email", tools)) {
    server.registerTool(
      "draft_email",
      {
        description:
          "Create a draft email from the given account without sending it. " +
          "Works identically to send_email — appends signature when " +
          "`include_signature` is true, applies style, and supports replies " +
          "and forwards — but saves the message to the Drafts folder " +
          "instead of sending. Returns the draft message ID and the draft's " +
          "HTML body content (`draftHtml`). Before sending the draft, " +
          "inspect `draftHtml` to verify the draft looks correct: no " +
          "duplicate signature blocks, no broken or missing inline images, " +
          "no malformed HTML, and no other formatting issues. Returns the " +
          "draft's shareable `webUrl` when available; recipients must have " +
          "access to the mailbox to open it.",
        inputSchema: sendEmailSchema,
        outputSchema: draftEmailOutputSchema,
      },
      async (args) =>
        handleSendOrDraft(
          args as SendEmailArgs,
          (p, a, m) => p.saveDraft(a, m),
          "draft",
          "draft_email",
        ),
    );
  }

  // ---------- edit_draft ----------

  const editDraftOutputSchema = {
    edited: z.literal(true),
    ...emailReferenceOutputSchema.shape,
    draftHtml: z.string().optional(),
    attachments: z.array(z.object({ id: z.string(), name: z.string(), contentType: z.string().optional(), size: z.number().optional() })).optional(),
  };

  if (shouldRegister("edit_draft", tools)) {
    server.registerTool(
      "edit_draft",
      {
        description:
          "Edit an existing draft email by ID. Only the fields you provide " +
          "are updated — unmentioned fields stay unchanged. Body edits work " +
          "like an exact text edit: provide `old_text` copied from the current " +
          "draft HTML and `new_text` to replace that exact section. The match " +
          "must occur exactly once, and all unselected content — including " +
          "reply/forward history — is preserved. Deprecated `body` is accepted " +
          "only as an alias for `new_text` when `old_text` is also provided. " +
          "Returns the draft ID and the draft's updated HTML body content " +
          "(`draftHtml`). Before sending, inspect `draftHtml` to verify the draft looks correct. " +
          "Does not support changing `inReplyTo` or `forwardMessageId` — " +
          "those are set at creation time via `draft_email`. Returns the " +
          "draft's shareable `webUrl` when available; recipients must have " +
          "access to the mailbox to open it.",
        inputSchema: editDraftSchema,
        outputSchema: editDraftOutputSchema,
      },
      async (args) => {
        const a = args as EditDraftArgs;
        try {
          const { provider, account } = registry.resolveByEmail(a.account);
          const hasNewText = a.new_text !== undefined;
          const hasBodyAlias = a.body !== undefined;
          const hasOldText = a.old_text !== undefined;
          if (hasNewText && hasBodyAlias) {
            return fail("Provide only one of new_text or deprecated body, not both.");
          }
          if (hasBodyAlias && !hasOldText) {
            return fail(
              "Body-only full replacement is no longer supported. " +
                "Provide old_text copied from the current draft HTML and use body as the replacement, or use new_text.",
            );
          }
          if (hasNewText && !hasOldText) {
            return fail("new_text requires old_text so only the selected section is edited.");
          }
          if (hasOldText && !hasNewText && !hasBodyAlias) {
            return fail("old_text requires new_text with the replacement content.");
          }

          const replacementText = a.new_text ?? a.body;
          if (replacementText !== undefined && a.include_signature && !account.signature) {
            return fail(
              "include_signature is true but no signature is configured for this account. " +
                "Set up a signature first with set_account_settings.",
            );
          }

          let bodyPayload: string | undefined;
          let isHtmlPayload: boolean | undefined;
          let bodyExpectation: BodyEditExpectation | undefined;
          if (replacementText !== undefined) {
            const existing = await provider.readEmail(account, a.id);
            const existingBody = existing.bodyHtml ?? existing.bodyText ?? "";
            const composed = composeBody({
              body: replacementText,
              format: a.format ?? "html",
              signature: account.signature,
              style: account.style,
              includeSignature: !!a.include_signature,
            });
            bodyPayload = applyExactTextEdit(existingBody, a.old_text ?? "", composed.body);
            isHtmlPayload = composed.isHtml;
            bodyExpectation = {
              expectedBody: bodyPayload,
              oldText: a.old_text ?? "",
              replacementBody: composed.body,
            };
          }

          const hasDraftUpdate =
            a.to !== undefined ||
            a.cc !== undefined ||
            a.bcc !== undefined ||
            a.subject !== undefined ||
            bodyPayload !== undefined;

          let currentId = a.id;
          let mutationReference: EmailReference = { id: currentId };
          if (a.remove_attachments?.length) {
            mutationReference = await provider.removeAttachmentsFromDraft(account, currentId, a.remove_attachments);
            currentId = mutationReference.id;
          }
          if (hasDraftUpdate) {
            const res = await provider.updateDraft(account, currentId, {
              to: a.to,
              cc: a.cc,
              bcc: a.bcc,
              subject: a.subject,
              body: bodyPayload,
              isHtml: isHtmlPayload,
            });
            currentId = res.id;
            mutationReference = res;
          }

          // Handle new attachments
          if (a.new_attachments && a.new_attachments.length > 0) {
            for (const att of a.new_attachments) {
              const fileData = readFileSync(att.filePath);
              const ext = extname(att.filePath).toLowerCase();
              const contentType =
                MIME_TYPES[ext] ?? "application/octet-stream";
              const attRes = await provider.addAttachmentToDraft(
                account,
                currentId,
                att.name ?? basename(att.filePath),
                fileData.toString("base64"),
                contentType,
              );
              currentId = attRes.id;
              mutationReference = { ...mutationReference, id: currentId };
            }
          }


          let draft;
          if (bodyExpectation) {
            draft = await readDraftWithVerifiedBody(
              provider,
              account,
              currentId,
              bodyExpectation,
            );

            if (!draft && provider.id === "outlook" && bodyPayload !== undefined) {
              const res = await provider.updateDraft(account, currentId, {
                body: bodyPayload,
                isHtml: isHtmlPayload,
              });
              currentId = res.id;
              mutationReference = res;
              draft = await readDraftWithVerifiedBody(
                provider,
                account,
                currentId,
                bodyExpectation,
              );
            }

            if (!draft) {
              return fail(
                "Draft body edit was not observable after saving. " +
                  "Retry edit_draft, or recreate the draft with draft_email before sending.",
              );
            }
          } else {
            try {
              draft = await provider.readEmail(account, currentId);
            } catch (error) {
              if (a.new_attachments?.length || a.remove_attachments?.length) {
                throw new Error(`Draft ${currentId} was changed but final attachment metadata could not be read: ${errMsg(error)}`);
              }
              // Recipient-only edits can still return their mutation reference.
              draft = undefined;
            }
          }

          const reference = draft
            ? {
                id: draft.id,
                ...(draft.webUrl !== undefined ? { webUrl: draft.webUrl } : {}),
                ...(draft.webUrlUnavailableReason !== undefined
                  ? { webUrlUnavailableReason: draft.webUrlUnavailableReason }
                  : {}),
              }
            : mutationReference;
          const result = {
            edited: true as const,
            ...reference,
            ...(draft ? { draftHtml: draft.bodyHtml ?? "" } : {}),
            ...(draft ? { attachments: draft.attachments } : {}),
          };
          return ok(result, result);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- send_draft ----------

  const sendDraftOutputSchema = {
    sent: z.literal(true),
    ...emailReferenceOutputSchema.shape,
  };

  if (shouldRegister("send_draft", tools)) {
    server.registerTool(
      "send_draft",
      {
        description:
          "Send an existing draft email by ID. " +
          "Use this with draft IDs returned by `draft_email` or `edit_draft`. " +
          "Returns the resulting message's shareable `webUrl` when available; " +
          "recipients must have access to the mailbox to open it.",
        inputSchema: {
          account: z.string().email(),
          id: z.string().min(1).describe("Draft message ID to send"),
        },
        outputSchema: sendDraftOutputSchema,
      },
      async (args) => {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          const res = await provider.sendDraft(account, args.id);
          const data = { sent: true as const, ...res };
          return ok(data, data);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }
}
