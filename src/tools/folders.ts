import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Registry } from "../providers/registry.js";
import type { ResolvedTools } from "../config.js";
import {
  ok,
  fail,
  errMsg,
  folderInfoOutputSchema,
  shouldRegister,
} from "./shared.js";

export function registerFolderTools(
  server: McpServer,
  ctx: {
    registry: Registry;
    tools: ResolvedTools;
  },
): void {
  const { registry, tools } = ctx;

  // ---------- list_folders ----------

  const listFoldersOutputSchema = z.object({
    account: z.string(),
    count: z.number(),
    items: z.array(folderInfoOutputSchema),
  });

  if (shouldRegister("list_folders", tools)) {
    server.registerTool(
      "list_folders",
      {
        description:
          "List available mail folders. Returns top-level folders by default, " +
          "or child folders of the given parent when `parentFolderId` is provided.",
        inputSchema: z.object({
          account: z.string().email(),
          parentFolderId: z
            .string()
            .optional()
            .describe(
              "When provided, lists child folders of this folder. " +
                "When omitted, lists top-level folders (children of the root).",
            ),
        }),
        outputSchema: listFoldersOutputSchema,
      },
      async (args) => {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          const items = await provider.listFolders(account, {
            parentFolderId: args.parentFolderId,
          });
          const data = {
            account: account.email,
            count: items.length,
            items,
          };
          return ok(data, data);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- create_folder ----------

  const createFolderOutputSchema = z.object({
    created: z.literal(true),
    folder: folderInfoOutputSchema,
  });

  if (shouldRegister("create_folder", tools)) {
    server.registerTool(
      "create_folder",
      {
        description:
          "Create a new mail folder. Creates under the root folder by default, " +
          "or under the specified parent when `parentFolderId` is provided.",
        inputSchema: z.object({
          account: z.string().email(),
          displayName: z
            .string()
            .min(1)
            .describe("Name of the new folder"),
          parentFolderId: z
            .string()
            .optional()
            .describe(
              "When provided, creates the folder as a child of this folder. " +
                "When omitted, creates under the root folder.",
            ),
        }),
        outputSchema: createFolderOutputSchema,
      },
      async (args) => {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          const folder = await provider.createFolder(account, {
            displayName: args.displayName,
            parentFolderId: args.parentFolderId,
          });
          const data = { created: true as const, folder };
          return ok(data, data);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- delete_folder ----------

  const deleteFolderOutputSchema = z.object({
    deleted: z.literal(true),
    id: z.string(),
  });

  if (shouldRegister("delete_folder", tools)) {
    server.registerTool(
      "delete_folder",
      {
        description:
          "Delete a mail folder by ID.",
        inputSchema: z.object({
          account: z.string().email(),
          folderId: z
            .string()
            .min(1)
            .describe("ID of the folder to delete"),
        }),
        outputSchema: deleteFolderOutputSchema,
      },
      async (args) => {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          await provider.deleteFolder(account, args.folderId);
          const data = { deleted: true as const, id: args.folderId };
          return ok(data, data);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- rename_folder ----------

  const renameFolderOutputSchema = z.object({
    renamed: z.literal(true),
    folder: folderInfoOutputSchema,
  });

  if (shouldRegister("rename_folder", tools)) {
    server.registerTool(
      "rename_folder",
      {
        description:
          "Rename an existing mail folder.",
        inputSchema: z.object({
          account: z.string().email(),
          folderId: z
            .string()
            .min(1)
            .describe("ID of the folder to rename"),
          newName: z
            .string()
            .min(1)
            .describe("New display name for the folder"),
        }),
        outputSchema: renameFolderOutputSchema,
      },
      async (args) => {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          const folder = await provider.renameFolder(
            account,
            args.folderId,
            args.newName,
          );
          const data = { renamed: true as const, folder };
          return ok(data, data);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }
}
