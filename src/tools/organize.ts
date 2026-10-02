import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Registry } from "../providers/registry.js";
import type { ResolvedTools } from "../config.js";
import {
  ok,
  fail,
  errMsg,
  emailReferenceOutputSchema,
  shouldRegister,
} from "./shared.js";

export function registerOrganizeTools(
  server: McpServer,
  ctx: {
    registry: Registry;
    tools: ResolvedTools;
  },
): void {
  const { registry, tools } = ctx;

  // Shared helpers — extract the resolved-account lookup and error handling
  // so archive/trash/mark_read/mark_unread handlers stay minimal.

  async function moveToWellKnown(
    args: { account: string; id: string },
    destination: string,
    resultKey: string,
  ) {
    const { provider, account } = registry.resolveByEmail(args.account);
    const reference = await provider.moveEmail(account, args.id, destination);
    const data: Record<string, unknown> = { ...reference };
    data[resultKey] = true;
    return ok(data, data);
  }

  async function markReadState(
    args: { account: string; id: string },
    isRead: boolean,
  ) {
    const { provider, account } = registry.resolveByEmail(args.account);
    const reference = await provider.markRead(account, args.id, isRead);
    const data = { marked: true as const, ...reference, isRead };
    return ok(data, data);
  }

  async function trashMessage(args: { account: string; id: string }) {
    const { provider, account } = registry.resolveByEmail(args.account);
    const reference = await provider.trashEmail(account, args.id);
    const data = { trashed: true as const, ...reference };
    return ok(data, data);
  }

  // ---------- archive ----------

  const archiveMoveSchema = z.object({
    account: z.string().email(),
    id: z.string().min(1).describe("Message ID to move"),
  });

  const archiveOutputSchema = emailReferenceOutputSchema.extend({
    archived: z.literal(true),
  });

  if (shouldRegister("archive_email", tools)) {
    server.registerTool(
      "archive_email",
      {
        description:
          "Move a message to the Archive folder. Returns `webUrl`, the shareable native web-client " +
          "link for the post-operation message; it may be omitted with `webUrlUnavailableReason`.",
        inputSchema: archiveMoveSchema,
        outputSchema: archiveOutputSchema,
      },
      async (args) => {
        try {
          return await moveToWellKnown(args, "archive", "archived");
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- trash ----------

  const trashOutputSchema = emailReferenceOutputSchema.extend({
    trashed: z.literal(true),
  });

  if (shouldRegister("trash_email", tools)) {
    server.registerTool(
      "trash_email",
      {
        description:
          "Move a message to the Deleted Items (trash) folder. Returns `webUrl`, the shareable native " +
          "web-client link for the post-operation message; it may be omitted with " +
          "`webUrlUnavailableReason`.",
        inputSchema: archiveMoveSchema,
        outputSchema: trashOutputSchema,
      },
      async (args) => {
        try {
          return await trashMessage(args);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- move ----------

  const moveEmailOutputSchema = emailReferenceOutputSchema.extend({
    moved: z.literal(true),
    destination: z.string(),
  });

  if (shouldRegister("move_email", tools)) {
    server.registerTool(
      "move_email",
      {
        description:
          "Move a message to any folder by well-known name (e.g. 'inbox', 'drafts', " +
          "'junkemail', 'sentitems', 'outbox') or custom folder ID. " +
          "Returns `webUrl`, the shareable native web-client link for the post-operation message; " +
          "it may be omitted with `webUrlUnavailableReason`.",
        inputSchema: z.object({
          account: z.string().email(),
          id: z.string().min(1).describe("Message ID to move"),
          destination: z
            .string()
            .min(1)
            .describe(
              "Destination folder — a well-known folder name " +
                "('archive', 'deleteditems', 'inbox', 'drafts', 'junkemail', " +
                "'sentitems', 'outbox') or a raw folder ID.",
            ),
        }),
        outputSchema: moveEmailOutputSchema,
      },
      async (args) => {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          const reference = await provider.moveEmail(account, args.id, args.destination);
          const data = {
            moved: true as const,
            ...reference,
            destination: args.destination,
          };
          return ok(data, data);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- mark_read / mark_unread ----------

  const markReadInputSchema = z.object({
    account: z.string().email(),
    id: z.string().min(1).describe("Message ID to mark as read"),
  });

  const markReadOutputSchema = emailReferenceOutputSchema.extend({
    marked: z.literal(true),
    isRead: z.boolean(),
  });

  if (shouldRegister("mark_read", tools)) {
    server.registerTool(
      "mark_read",
      {
        description:
          "Mark a message as read. Returns `webUrl`, the shareable native web-client link for the " +
          "post-operation message; it may be omitted with `webUrlUnavailableReason`.",
        inputSchema: markReadInputSchema,
        outputSchema: markReadOutputSchema,
      },
      async (args) => {
        try {
          return await markReadState(args, true);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  if (shouldRegister("mark_unread", tools)) {
    server.registerTool(
      "mark_unread",
      {
        description:
          "Mark a message as unread. Returns `webUrl`, the shareable native web-client link for the " +
          "post-operation message; it may be omitted with `webUrlUnavailableReason`.",
        inputSchema: markReadInputSchema,
        outputSchema: markReadOutputSchema,
      },
      async (args) => {
        try {
          return await markReadState(args, false);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }
}
