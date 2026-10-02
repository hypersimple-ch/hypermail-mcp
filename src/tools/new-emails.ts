import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ResolvedTools } from "../config.js";
import type { EmailProvider, EmailFull, EmailSummary } from "../providers/types.js";
import type { Registry } from "../providers/registry.js";
import type { AccountRecord, AccountStore, NewEmailClaimCandidate } from "../store/account-store.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import { selectBody } from "../html-to-markdown.js";
import {
  attachmentMetaOutputSchema,
  emailAddrOutputSchema,
  emailWebLinkOutputSchema,
  errMsg,
  fail,
  ok,
  shouldRegister,
} from "./shared.js";
import {
  compareTimestamp,
  effectiveReceivedAt,
  normalizeTimestamp,
  withAccountPollTimeout,
} from "./new-emails-timeout.js";

const DEFAULT_LIMIT = 10;
const BODY_LIMIT = 20_000;
const PAGE_SIZE = 100;

type NewEmailCheckpoint = NonNullable<AccountRecord["newEmailCheckpoint"]>;

interface Candidate {
  account: AccountRecord;
  summary: EmailSummary;
  timestamp: string;
}

interface AccountCandidates {
  account: AccountRecord;
  candidates: Candidate[];
  proposedCheckpoint?: NewEmailCheckpoint;
}

interface NewEmailOutput {
  account: string;
  id: string;
  subject: string;
  from?: EmailFull["from"];
  to?: EmailFull["to"];
  cc?: EmailFull["cc"];
  bcc?: EmailFull["bcc"];
  receivedAt?: string;
  preview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  folder?: string;
  attachments?: EmailFull["attachments"];
  webUrl?: string;
  webUrlUnavailableReason?: string;
  body: string;
  bodyFormat: "markdown";
  bodyTruncated: boolean;
  bodyOriginalLength: number;
}

interface HydratedCandidate {
  candidate: Candidate;
  email: NewEmailOutput;
  fullId: string;
}

export function registerNewEmailTool(
  server: McpServer,
  ctx: { store: AccountStore; registry: Registry; tools: ResolvedTools; logger?: Logger },
): void {
  const { store, registry, tools, logger = noopLogger } = ctx;
  if (!shouldRegister("get_new_emails", tools)) return;

  const newEmailOutputSchema = emailWebLinkOutputSchema.extend({
    account: z.string(),
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
    body: z.string(),
    bodyFormat: z.literal("markdown"),
    bodyTruncated: z.boolean(),
    bodyOriginalLength: z.number(),
  });

  const outputSchema = z.object({
    count: z.number(),
    emails: z.array(newEmailOutputSchema),
    errors: z.array(z.object({ account: z.string(), message: z.string() })),
  });

  server.registerTool(
    "get_new_emails",
    {
      description:
        "Fetch a bounded batch of inbox emails not previously returned by this tool. " +
        "Agents should call this on their own schedule. Bodies are returned as markdown and may be truncated. " +
        "Each email may include `webUrl`, a user-shareable native-client link that requires mailbox access, " +
        "or `webUrlUnavailableReason` when no link is available.",
      inputSchema: z.object({
        account: z
          .string()
          .email()
          .optional()
          .describe(
            "Email account to poll. If omitted, polls all accounts with one global limit.",
          ),
        limit: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_LIMIT)
          .optional()
          .describe(
            "Maximum emails to return. Defaults to 10. Use 0 to initialize/check without fetching bodies.",
          ),
      }),
      outputSchema,
    },
    async (args) => {
      const limit = args.limit ?? DEFAULT_LIMIT;
      logger.debug("get-new-emails", "start", {
        account: args.account ?? null,
        limit,
      });

      if (args.account) {
        try {
          const { provider, account } = registry.resolveByEmail(args.account);
          const result = await withAccountPollTimeout(
            account.email,
            "collect new-email candidates",
            collectCandidatesForAccount(provider, account, logger),
          );
          await commitInitialCheckpoint(store, result, logger);
          const selected = oldestCandidatesFirst(result.candidates).slice(0, limit);
          logger.debug("get-new-emails", "selected", {
            account: result.account.email,
            candidateCount: result.candidates.length,
            selectedCount: selected.length,
            selectedIds: selected.map((candidate) => candidate.summary.id),
            selectedReceivedAt: selected.map((candidate) => candidate.timestamp),
            limit,
          });
          const hydrated = limit === 0
            ? []
            : await withAccountPollTimeout(
                result.account.email,
                "hydrate new emails",
                hydrateCandidates(provider, result.account, selected, logger),
              );
          const emails = await claimHydratedCandidates(store, result.account, hydrated, logger);
          const data = { count: emails.length, emails, errors: [] };
          logger.debug("get-new-emails", "end", {
            account: result.account.email,
            returnedCount: emails.length,
            errorCount: 0,
          });
          return ok(data, data);
        } catch (err) {
          logger.debug("get-new-emails", "error", {
            account: args.account,
            message: errMsg(err),
          });
          return fail(errMsg(err));
        }
      }

      const accounts = store.listAccounts();
      if (accounts.length === 0) {
        logger.debug("get-new-emails", "end", {
          accountCount: 0,
          returnedCount: 0,
          errorCount: 1,
        });
        return fail("no accounts registered. Call add_account first.");
      }

      const errors: Array<{ account: string; message: string }> = [];
      const collected: Candidate[] = [];
      const providersByEmail = new Map<string, EmailProvider>();
      const accountsByEmail = new Map<string, AccountRecord>();

      const collectedByAccount = await Promise.all(
        accounts.map(async (stored) => {
          try {
            const { provider, account } = registry.resolveByEmail(stored.email);
            const result = await withAccountPollTimeout(
              account.email,
              "collect new-email candidates",
              collectCandidatesForAccount(provider, account, logger),
            );
            await commitInitialCheckpoint(store, result, logger);
            return {
              status: "ok" as const,
              account: result.account,
              provider,
              candidates: result.candidates,
            };
          } catch (err) {
            const message = errMsg(err);
            logger.debug("get-new-emails", "accountError", { account: stored.email, message });
            return {
              status: "error" as const,
              account: stored.email,
              message,
            };
          }
        }),
      );

      for (const result of collectedByAccount) {
        if (result.status === "error") {
          errors.push({ account: result.account, message: result.message });
          continue;
        }
        providersByEmail.set(result.account.email, result.provider);
        accountsByEmail.set(result.account.email, result.account);
        collected.push(...result.candidates);
      }

      const selected = oldestCandidatesFirst(collected).slice(0, limit);
      logger.debug("get-new-emails", "selected", {
        accountCount: accounts.length,
        candidateCount: collected.length,
        selectedCount: selected.length,
        selectedIds: selected.map((candidate) => candidate.summary.id),
        selectedReceivedAt: selected.map((candidate) => candidate.timestamp),
        limit,
      });
      const emails: NewEmailOutput[] = [];

      if (limit > 0) {
        const byAccount = new Map<string, Candidate[]>();
        for (const candidate of selected) {
          const items = byAccount.get(candidate.account.email) ?? [];
          items.push(candidate);
          byAccount.set(candidate.account.email, items);
        }

        const hydratedByAccount = await Promise.all(
          [...byAccount].map(async ([email, accountCandidates]) => {
            const provider = providersByEmail.get(email);
            const account = accountsByEmail.get(email);
            if (!provider || !account) return { status: "ok" as const, emails: [] };
            try {
              const hydrated = await withAccountPollTimeout(
                email,
                "hydrate new emails",
                hydrateCandidates(provider, account, accountCandidates, logger),
              );
              return {
                status: "ok" as const,
                emails: await claimHydratedCandidates(store, account, hydrated, logger),
              };
            } catch (err) {
              const message = errMsg(err);
              logger.debug("get-new-emails", "accountError", { account: email, message });
              return {
                status: "error" as const,
                account: email,
                message,
              };
            }
          }),
        );

        for (const result of hydratedByAccount) {
          if (result.status === "error") {
            errors.push({ account: result.account, message: result.message });
            continue;
          }
          emails.push(...result.emails);
        }
      }

      const orderedEmails = emails.sort(compareNewEmailOutputOldestFirst);
      const data = { count: orderedEmails.length, emails: orderedEmails, errors };
      logger.debug("get-new-emails", "end", {
        accountCount: accounts.length,
        returnedCount: orderedEmails.length,
        errorCount: errors.length,
      });
      return ok(data, data);
    },
  );
}

async function collectCandidatesForAccount(
  provider: EmailProvider,
  account: AccountRecord,
  logger: Logger,
): Promise<AccountCandidates> {
  const checkpoint = normalizeCheckpoint(account.newEmailCheckpoint);
  if (!checkpoint) {
    const proposedCheckpoint = await proposeInitialCheckpoint(provider, account);
    logger.debug("get-new-emails", "candidatesCollected", {
      account: account.email,
      initialized: true,
      candidateCount: 0,
    });
    return { account, candidates: [], proposedCheckpoint };
  }

  const deliveredAtCheckpoint = new Set(checkpoint.deliveredIdsAtReceivedAt ?? []);
  const candidates: Candidate[] = [];
  let skip = 0;

  while (true) {
    const { items, hasMore } = await provider.listEmails(account, {
      folder: "inbox",
      limit: PAGE_SIZE,
      skip,
    });

    if (items.length === 0) break;

    let sawOlderThanCheckpoint = false;
    for (const item of items) {
      const timestamp = effectiveReceivedAt(item.receivedAt);
      const comparison = compareTimestamp(timestamp, checkpoint.receivedAt);

      if (comparison > 0) {
        candidates.push({ account, summary: item, timestamp });
      } else if (comparison === 0) {
        if (!deliveredAtCheckpoint.has(item.id)) {
          candidates.push({ account, summary: item, timestamp });
        }
      } else {
        sawOlderThanCheckpoint = true;
      }
    }

    if (sawOlderThanCheckpoint || !hasMore) break;
    skip += items.length;
  }

  logger.debug("get-new-emails", "candidatesCollected", {
    account: account.email,
    initialized: false,
    checkpointReceivedAt: checkpoint.receivedAt,
    deliveredIdCount: checkpoint.deliveredIdsAtReceivedAt?.length ?? 0,
    candidateCount: candidates.length,
    candidateIds: candidates.map((candidate) => candidate.summary.id),
    candidateReceivedAt: candidates.map((candidate) => candidate.timestamp),
  });
  return { account, candidates };
}

async function proposeInitialCheckpoint(
  provider: EmailProvider,
  account: AccountRecord,
): Promise<NewEmailCheckpoint> {
  const { items } = await provider.listEmails(account, {
    folder: "inbox",
    limit: PAGE_SIZE,
  });

  const first = items[0];
  const receivedAt = first
    ? effectiveReceivedAt(first.receivedAt)
    : new Date().toISOString();
  const deliveredIdsAtReceivedAt = items
    .filter((item) => effectiveReceivedAt(item.receivedAt) === receivedAt)
    .map((item) => item.id);

  return { receivedAt, deliveredIdsAtReceivedAt };
}

// Only the caller that wins the provider timeout may persist its baseline.
async function commitInitialCheckpoint(
  store: AccountStore,
  result: AccountCandidates,
  logger: Logger,
): Promise<void> {
  if (!result.proposedCheckpoint) return;
  const { receivedAt, deliveredIdsAtReceivedAt } = result.proposedCheckpoint;
  await store.updateNewEmailCheckpoint(result.account.email, result.proposedCheckpoint);
  logger.debug("get-new-emails", "checkpointInitialized", {
    account: result.account.email,
    receivedAt,
    deliveredIdCount: deliveredIdsAtReceivedAt?.length ?? 0,
  });
}

async function hydrateCandidates(
  provider: EmailProvider,
  account: AccountRecord,
  selected: Candidate[],
  logger: Logger,
): Promise<HydratedCandidate[]> {
  if (selected.length === 0) {
    logger.debug("get-new-emails", "hydrated", {
      account: account.email,
      selectedCount: 0,
      hydratedCount: 0,
      claimedCount: 0,
    });
    return [];
  }

  const hydrated: HydratedCandidate[] = [];

  for (const candidate of selected) {
    const full = await provider.readEmail(account, candidate.summary.id);
    hydrated.push({
      candidate,
      email: formatNewEmail(account.email, full, candidate.summary),
      fullId: full.id,
    });
  }

  logger.debug("get-new-emails", "hydrated", {
    account: account.email,
    selectedCount: selected.length,
    hydratedCount: hydrated.length,
  });
  return hydrated;
}

// Durable claims must be awaited, never raced against a provider timeout.
async function claimHydratedCandidates(
  store: AccountStore,
  account: AccountRecord,
  hydrated: HydratedCandidate[],
  logger: Logger,
): Promise<NewEmailOutput[]> {
  if (hydrated.length === 0) return [];
  const claims: NewEmailClaimCandidate[] = hydrated.map(({ candidate, fullId }) => ({
    summaryId: candidate.summary.id,
    receivedAt: candidate.timestamp,
    ids: [candidate.summary.id, fullId],
  }));
  const claimed = new Set(await store.claimNewEmails(account.email, claims));
  logger.debug("get-new-emails", "claimed", {
    account: account.email,
    claimCount: claims.length,
    claimedCount: claimed.size,
    claimIds: claims.map((claim) => claim.summaryId),
    claimedIds: [...claimed],
  });

  return hydrated
    .filter(({ candidate }) => claimed.has(candidate.summary.id))
    .map(({ email }) => email);
}

function formatNewEmail(
  account: string,
  msg: EmailFull,
  summary: EmailSummary,
): NewEmailOutput {
  const body = selectBody(msg, "markdown");
  const bodyTruncated = body.length > BODY_LIMIT;
  return {
    account,
    id: msg.id,
    subject: msg.subject,
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    receivedAt: msg.receivedAt ?? summary.receivedAt,
    preview: msg.preview,
    isRead: msg.isRead,
    hasAttachments: msg.hasAttachments,
    folder: msg.folder,
    attachments: msg.attachments,
    webUrl: msg.webUrl,
    webUrlUnavailableReason: msg.webUrlUnavailableReason,
    body: bodyTruncated ? body.slice(0, BODY_LIMIT) : body,
    bodyFormat: "markdown",
    bodyTruncated,
    bodyOriginalLength: body.length,
  };
}

function normalizeCheckpoint(
  checkpoint: AccountRecord["newEmailCheckpoint"],
): NewEmailCheckpoint | null {
  const receivedAt = normalizeTimestamp(checkpoint?.receivedAt);
  if (!receivedAt) return null;
  return {
    receivedAt,
    deliveredIdsAtReceivedAt: checkpoint?.deliveredIdsAtReceivedAt ?? [],
  };
}

function oldestCandidatesFirst(items: Candidate[]): Candidate[] {
  return [...items].sort((a, b) => {
    const byTimestamp = compareTimestamp(a.timestamp, b.timestamp);
    if (byTimestamp !== 0) return byTimestamp;
    return a.summary.id.localeCompare(b.summary.id);
  });
}

function compareNewEmailOutputOldestFirst(
  a: NewEmailOutput,
  b: NewEmailOutput,
): number {
  const byTimestamp = compareTimestamp(
    effectiveReceivedAt(a.receivedAt),
    effectiveReceivedAt(b.receivedAt),
  );
  if (byTimestamp !== 0) return byTimestamp;
  return a.id.localeCompare(b.id);
}

