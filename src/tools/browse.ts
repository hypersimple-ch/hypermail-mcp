import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Registry } from "../providers/registry.js";
import type { ResolvedTools } from "../config.js";
import type { AccountStore } from "../store/account-store.js";
import type { Logger } from "../logger.js";
import { selectBody } from "../html-to-markdown.js";
import {
  ok,
  fail,
  errMsg,
  emailAddrOutputSchema,
  emailSummaryOutputSchema,
  emailWebLinkOutputSchema,
  attachmentMetaOutputSchema,
  shouldRegister,
} from "./shared.js";
import { registerNewEmailTool } from "./new-emails.js";

export function registerBrowseTools(
  server: McpServer,
  ctx: {
    store: AccountStore;
    registry: Registry;
    tools: ResolvedTools;
    logger?: Logger;
  },
): void {
  const { store, registry, tools, logger } = ctx;

  // ---------- email ops ----------

  const emailListOutputSchema = z.object({
    account: z.string(),
    count: z.number(),
    items: z.array(emailSummaryOutputSchema),
    skip: z.number(),
    hasMore: z.boolean(),
  });

  const searchEmailSummaryOutputSchema = emailSummaryOutputSchema.extend({
    account: z.string(),
  });

  const searchEmailsOutputSchema = z.object({
    account: z.string(),
    count: z.number(),
    items: z.array(searchEmailSummaryOutputSchema),
    accounts: z.array(z.string()).optional(),
    errors: z.array(z.object({ account: z.string(), message: z.string() })).optional(),
  });

  if (shouldRegister("list_emails", tools)) {
    server.registerTool(
      "list_emails",
      {
        description:
          "List recent emails in a folder of the given account. Pass the user's email " +
          "address as `account`; the server routes to the correct backend automatically. " +
          "Each item may include `webUrl`, a user-shareable native-client link that requires mailbox access, " +
          "or `webUrlUnavailableReason` when no link is available.",
        inputSchema: z.object({
          account: z.string().email(),
          folder: z.string().default("inbox").optional(),
          limit: z.number().int().positive().max(100).optional(),
          unreadOnly: z.boolean().optional(),
          skip: z.number().int().min(0).optional(),
        }),
        outputSchema: emailListOutputSchema,
      },
      async (args) => {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          const { items, hasMore } = await provider.listEmails(account, {
            folder: args.folder,
            limit: args.limit,
            unreadOnly: args.unreadOnly,
            skip: args.skip,
          });
          const data = {
            account: account.email,
            count: items.length,
            items,
            skip: args.skip ?? 0,
            hasMore,
          };
          return ok(data, data);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  registerNewEmailTool(server, { store, registry, tools, logger });

  if (shouldRegister("search_emails", tools)) {
    const criterionSchema = z.string().trim().min(1).optional();
    const searchEmailsInputSchema = z
      .object({
        account: z.string().email().optional(),
        query: criterionSchema.describe("Optional free-text search query."),
        from: criterionSchema.describe("Match the sender."),
        to: criterionSchema.describe("Match a direct recipient."),
        cc: criterionSchema.describe("Match a CC or BCC recipient."),
        limit: z.number().int().positive().max(100).optional(),
      })
      .refine(
        (args) => args.query || args.from || args.to || args.cc,
        { message: "at least one of query, from, to, or cc is required" },
      );

    server.registerTool(
      "search_emails",
      {
        description:
          "Search emails using optional free text and address filters. `cc` searches both CC and BCC. " +
          "Supplied criteria are combined with AND. Pass `account` to search one account, or omit it " +
          "to search all registered accounts in parallel. Each item may include `webUrl`, a user-shareable " +
          "native-client link that requires mailbox access, or `webUrlUnavailableReason` when no link is available.",
        inputSchema: searchEmailsInputSchema,
        outputSchema: searchEmailsOutputSchema,
      },
      async (args) => {
        const searchOptions = {
          ...(args.query ? { query: args.query } : {}),
          ...(args.from ? { from: args.from } : {}),
          ...(args.to ? { to: args.to } : {}),
          ...(args.cc ? { cc: args.cc } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        };

        if (args.account) {
          try {
            const { provider, account } = registry.resolveByEmail(args.account);
            const items = await provider.searchEmails(account, searchOptions);
            const data = {
              account: account.email,
              count: items.length,
              items: items.map((item) => ({ ...item, account: account.email })),
              errors: [],
            };
            return ok(data, data);
          } catch (err) {
            return fail(errMsg(err));
          }
        }

        const accounts = store.listAccounts();
        if (accounts.length === 0) {
          return fail("no accounts registered. Call add_account first.");
        }

        const results = await Promise.all(
          accounts.map(async (stored) => {
            try {
              const { provider, account } = registry.resolveByEmail(stored.email);
              const items = await provider.searchEmails(account, searchOptions);
              return {
                account: account.email,
                items: items.map((item) => ({ ...item, account: account.email })),
              };
            } catch (err) {
              return {
                account: stored.email,
                error: errMsg(err),
              };
            }
          }),
        );

        const items = results.flatMap((result) => result.items ?? []);
        const errors = results
          .filter((result): result is { account: string; error: string } =>
            "error" in result,
          )
          .map((result) => ({ account: result.account, message: result.error }));
        const data = {
          account: "all",
          accounts: accounts.map((account) => account.email),
          count: items.length,
          items,
          errors,
        };
        return ok(data, data);
      },
    );
  }

  const readEmailOutputSchema = z.object({
    id: z.string(),
    subject: z.string(),
    from: emailAddrOutputSchema.optional(),
    to: z.array(emailAddrOutputSchema).optional(),
    cc: z.array(emailAddrOutputSchema).optional(),
    bcc: z.array(emailAddrOutputSchema).optional(),
    receivedAt: z.string().optional(),
    preview: z.string().optional(),
    isRead: z.boolean().optional(),
    hasAttachments: z.boolean().optional(),
    folder: z.string().optional(),
    attachments: z.array(attachmentMetaOutputSchema).optional(),
    webUrl: z.string().url().optional(),
    webUrlUnavailableReason: z.string().optional(),
    body: z.string(),
    bodyFormat: z.enum(["markdown", "html"]),
  });

  if (shouldRegister("read_email", tools)) {
    server.registerTool(
      "read_email",
      {
        description:
          "Fetch a single email with full body and recipients by id. " +
          "Body is returned as `body` with `bodyFormat` indicating the format. " +
          "Default format is 'markdown' — HTML is automatically converted to save context tokens. " +
          "The response may include `webUrl`, a user-shareable native-client link that requires mailbox access, " +
          "or `webUrlUnavailableReason` when no link is available.",
        inputSchema: z.object({
          account: z.string().email(),
          id: z.string().min(1),
          format: z
            .enum(["markdown", "html"])
            .default("markdown")
            .optional()
            .describe(
              "Output body format. 'markdown' converts HTML to Markdown (default), " +
                "'html' returns the raw HTML. Plain-text-only messages retain their original body.",
            ),
        }),
        outputSchema: readEmailOutputSchema,
      },
      async (args) => {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          const msg = await provider.readEmail(account, args.id);
          const format = args.format ?? "markdown";
          const body = selectBody(msg, format);
          const data = {
            id: msg.id,
            subject: msg.subject,
            from: msg.from,
            to: msg.to,
            cc: msg.cc,
            bcc: msg.bcc,
            receivedAt: msg.receivedAt,
            preview: msg.preview,
            isRead: msg.isRead,
            hasAttachments: msg.hasAttachments,
            folder: msg.folder,
            attachments: msg.attachments,
            webUrl: msg.webUrl,
            webUrlUnavailableReason: msg.webUrlUnavailableReason,
            body,
            bodyFormat: format,
          };
          return ok(data, data as Record<string, unknown>);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  const readAttachmentOutputSchema = emailWebLinkOutputSchema.extend({
    name: z.string(),
    contentType: z.string().optional(),
    path: z.string(),
  });

  if (shouldRegister("read_attachment", tools)) {
    server.registerTool(
      "read_attachment",
      {
        description:
          "Download an email attachment to a temporary file and return its path. " +
          "Use messageId and attachmentId from a prior read_email call. The response may include the parent " +
          "message's `webUrl`, a user-shareable native-client link that requires mailbox access, or " +
          "`webUrlUnavailableReason` when no link is available.",
        inputSchema: z.object({
          account: z.string().email(),
          messageId: z.string().min(1),
          attachmentId: z.string().min(1),
        }),
        outputSchema: readAttachmentOutputSchema,
      },
      async (args) => {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          const res = await provider.readAttachment(
            account,
            args.messageId,
            args.attachmentId,
          );
          return ok(res, res as unknown as Record<string, unknown>);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }
}
