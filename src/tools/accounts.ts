import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import { z } from "zod";

import type { AccountRecord, AccountStore } from "../store/account-store.js";
import type { Registry } from "../providers/registry.js";
import type { ProviderId } from "../providers/types.js";
import type { ResolvedTools } from "../config.js";
import {
  ok,
  fail,
  errMsg,
  providerIdEnum,
  accountSummaryOutputSchema,
  accountFullOutputSchema,
  publicAccountResult,
  styleOutputSchema,
  shouldRegister,
} from "./shared.js";

export function registerAccountTools(
  server: McpServer,
  ctx: {
    store: AccountStore;
    registry: Registry;
    tools: ResolvedTools;
  },
): void {
  const { store, registry, tools } = ctx;

  // ---------- list_accounts ----------

  const listAccountsOutputSchema = z.object({
    accounts: z.array(accountSummaryOutputSchema),
  });

  if (shouldRegister("list_accounts", tools)) {
    server.registerTool(
      "list_accounts",
      {
        description:
          "List all email accounts known to this server (no secrets). " +
          "Use the returned `email` value as the `account` argument to other tools.",
        inputSchema: z.object({}),
        outputSchema: listAccountsOutputSchema,
      },
      async () => {
        const rows = store.listAccounts().map((a) => ({
          email: a.email,
          provider: a.provider,
          displayName: a.displayName,
          addedAt: a.addedAt,
          hasSignature: !!a.signature,
          hasStyle: !!(
            a.style &&
            (a.style.fontFamily || a.style.fontSize || a.style.fontColor)
          ),
        }));
        const data = { accounts: rows };
        return ok(data, data);
      },
    );
  }

  // ---------- add_account ----------

  const addAccountOutputSchema = z.object({
      status: z.enum(["pending", "ready"]),
      handle: z.string().optional(),
      verification: z
        .object({
          type: z.enum(["device_code", "oauth_url"]).optional(),
          userCode: z.string(),
          verificationUri: z.string(),
          expiresAt: z.string(),
          message: z.string(),
        })
        .optional(),
      account: accountFullOutputSchema.optional(),
    });

  if (shouldRegister("add_account", tools)) {
    server.registerTool(
      "add_account",
      {
        description:
          "Start adding an email account. For Outlook this returns a device code " +
          "the user must enter at the verification URL; then call `complete_add_account` " +
          "with the returned `handle` to finalize.",
        inputSchema: z.object({
          provider: providerIdEnum.describe("Email backend. 'outlook' (Microsoft Graph) and 'imap' are fully implemented."),
          email: z
            .string()
            .email()
            .optional()
            .describe(
              "Optional hint — the provider will verify it against the auth result.",
            ),
          config: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Provider-specific config (e.g. IMAP host/port). Unused for Outlook.",
            ),
        }),
        outputSchema: addAccountOutputSchema,
      },
      async (args) => {
        const provider = registry.get(args.provider as ProviderId);
        try {
          const res = await provider.addAccount({
            email: args.email,
            config: args.config,
          });
          const data = publicAccountResult(res);
          return ok(data, data as unknown as Record<string, unknown>);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- complete_add_account ----------

  const completeAddAccountOutputSchema = z.object({
    status: z.enum(["pending", "ready", "expired", "error"]),
    account: accountFullOutputSchema.optional(),
    error: z.string().optional(),
  });

  if (shouldRegister("complete_add_account", tools)) {
    server.registerTool(
      "complete_add_account",
      {
        description:
          "Poll/finalize a pending add_account flow. Returns `pending` until the user " +
          "completes the device-code step, then `ready` with the persisted account.",
        inputSchema: z.object({
          provider: providerIdEnum,
          handle: z.string().min(1),
          authorizationResponse: z
            .string()
            .optional()
            .describe(
              "For OAuth providers such as Gmail: paste the full final redirected URL from the browser after consent.",
            ),
          code: z
            .string()
            .optional()
            .describe(
              "For OAuth providers such as Gmail: raw authorization code if the client extracted it from the redirect URL.",
            ),
          state: z
            .string()
            .optional()
            .describe(
              "For OAuth providers such as Gmail: OAuth state returned with a raw authorization code.",
            ),
        }),
        outputSchema: completeAddAccountOutputSchema,
      },
      async (args) => {
        const provider = registry.get(args.provider as ProviderId);
        if (!provider.completeAddAccount) {
          return fail(
            `provider ${args.provider} has no async add-account flow`,
          );
        }
        try {
          const res = await provider.completeAddAccount(args.handle, {
            authorizationResponse: args.authorizationResponse,
            code: args.code,
            state: args.state,
          });
          const data = publicAccountResult(res);
          return ok(data, data as unknown as Record<string, unknown>);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- account settings ----------

  const accountSettingsOutputSchema = z.object({
    signature: z.string().nullable(),
    style: styleOutputSchema.nullable(),
  });

  if (shouldRegister("get_account_settings", tools)) {
    server.registerTool(
      "get_account_settings",
      {
        description:
          "Get signature (HTML) and style preferences for an account.",
        inputSchema: z.object({ account: z.string().email() }),
        outputSchema: accountSettingsOutputSchema,
      },
      async (args) => {
        try {
          const acct = store.getAccount(args.account);
          if (!acct)
            return fail(`no account registered for "${args.account}"`);
          const data = {
            signature: acct.signature ?? null,
            style: acct.style ?? null,
          };
          return ok(data, data as Record<string, unknown>);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  if (shouldRegister("set_account_settings", tools)) {
    server.registerTool(
      "set_account_settings",
      {
        description:
          "Set signature (HTML snippet) and/or style preferences for an account. " +
          "Use `signaturePath` to load a signature from a file (useful for signatures with base64 images). " +
          "`signature` and `signaturePath` are mutually exclusive.",
        inputSchema: z
          .object({
            account: z.string().email(),
            signature: z
              .string()
              .optional()
              .describe(
                "HTML snippet — may contain formatting, images, links. " +
                  "Pass an empty string to clear. " +
                  "Mutually exclusive with `signaturePath`.",
              ),
            signaturePath: z
              .string()
              .optional()
              .describe(
                "Path to a file containing the signature HTML. " +
                  "The file content is read and stored as the signature. " +
                  "Useful when the signature contains large base64 images. " +
                  "Mutually exclusive with `signature`.",
              ),
            style: z
              .object({
                fontFamily: z.string().optional(),
                fontSize: z.string().optional(),
                fontColor: z.string().optional(),
              })
              .nullable()
              .optional()
              .describe(
                "Font preferences applied to outgoing HTML emails. Pass null to clear.",
              ),
          })
          .refine(
            (data) => !(data.signature !== undefined && data.signaturePath),
            {
              message:
                "signature and signaturePath are mutually exclusive — use one or the other",
            },
          ),
        outputSchema: accountSettingsOutputSchema,
      },
      async (args) => {
        try {
          const acct = store.getAccount(args.account);
          if (!acct)
            return fail(`no account registered for "${args.account}"`);
          const patch: {
            signature?: string | null;
            style?: AccountRecord["style"] | null;
          } = {};
          if (args.signaturePath !== undefined) {
            patch.signature = (await fs.readFile(args.signaturePath, "utf-8")) || null;
          } else if (args.signature !== undefined) {
            patch.signature = args.signature || null;
          }
          if (args.style !== undefined) patch.style = args.style;
          const updated = await store.updateSettings(args.account, patch);
          if (!updated)
            return fail(`no account registered for "${args.account}"`);
          const data = {
            signature: updated.signature ?? null,
            style: updated.style ?? null,
          };
          return ok(data, data as Record<string, unknown>);
        } catch (err) {
          return fail(errMsg(err));
        }
      },
    );
  }

  // ---------- remove_account ----------

  const removeAccountOutputSchema = z.object({
    removed: z.boolean(),
    email: z.string(),
  });

  if (shouldRegister("remove_account", tools)) {
    server.registerTool(
      "remove_account",
      {
        description:
          "Forget an account and delete its stored tokens.",
        inputSchema: z.object({ email: z.string().email() }),
        outputSchema: removeAccountOutputSchema,
      },
      async (args) => {
        const removed = await store.removeAccount(args.email);
        const data = { removed, email: args.email };
        return ok(data, data);
      },
    );
  }
}
