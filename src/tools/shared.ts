import { z } from "zod";
import type { ResolvedTools } from "../config.js";
import type { AccountRecord } from "../store/account-store.js";
import { markdownToHtml } from "../markdown-to-html.js";
import { THREAD_MARKER } from "../providers/outlook/write-ops.js";

/** JSON-stringify a value into a single MCP text content block. */
export function ok(
  data: unknown,
  structuredContent?: Record<string, unknown>,
) {
  const result: {
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
  } = {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
  if (structuredContent !== undefined) {
    result.structuredContent = structuredContent;
  }
  return result;
}

export function fail(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function graphErrorDetails(err: unknown): Record<string, unknown> | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as Record<string, unknown>;
  const details: Record<string, unknown> = {};

  for (const key of ["code", "statusCode", "requestId", "date", "innerError"]) {
    if (record[key] !== undefined) details[key] = record[key];
  }

  if (typeof record.body === "string") {
    try {
      const parsed = JSON.parse(record.body) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const graphError = (parsed as Record<string, unknown>).error;
        if (typeof graphError === "object" && graphError !== null) {
          const graphRecord = graphError as Record<string, unknown>;
          for (const key of ["code", "message", "innerError"]) {
            if (graphRecord[key] !== undefined && details[key] === undefined) {
              details[key] = graphRecord[key];
            }
          }
        }
      }
    } catch {
      // Keep the original message when the body is not JSON.
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

export function errMsg(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("HYPERMAIL_GMAIL_CLIENT_ID")) {
    return "Missing Gmail OAuth configuration: set HYPERMAIL_GMAIL_CLIENT_ID before adding a Gmail account.";
  }

  const details = graphErrorDetails(err);
  if (!details) return message;

  return `${message}\n${JSON.stringify({ error: details }, null, 2)}`;
}

// ── shared schemas ──

/** Enum matching {@link import("../providers/types.js").ProviderId}. */
export const providerIdEnum = z.enum(["outlook", "imap", "gmail"]);

export const emailAddrSchema = z.object({
  address: z.string().email(),
  name: z.string().optional(),
});

export const emailAddrOutputSchema = z.object({
  name: z.string().optional(),
  address: z.string(),
});

export const accountSummaryOutputSchema = z.object({
  email: z.string(),
  provider: providerIdEnum,
  displayName: z.string().optional(),
  addedAt: z.string(),
  hasSignature: z.boolean(),
  hasStyle: z.boolean(),
});

export const styleOutputSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.string().optional(),
  fontColor: z.string().optional(),
});

/** Public account record. Never expose provider tokens or other stored secrets. */
export const accountFullOutputSchema = z.object({
  email: z.string(),
  provider: providerIdEnum,
  displayName: z.string().optional(),
  addedAt: z.string(),
  signature: z.string().optional(),
  style: styleOutputSchema.optional(),
});

export function publicAccount(account: AccountRecord) {
  return {
    email: account.email,
    provider: account.provider,
    displayName: account.displayName,
    addedAt: account.addedAt,
    signature: account.signature,
    style: account.style,
  };
}

export function publicAccountResult(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) {
    return { result };
  }
  const record = result as Record<string, unknown>;
  const account = record.account as AccountRecord | undefined;
  if (!account) return record;
  return { ...record, account: publicAccount(account) };
}

export const emailWebLinkOutputSchema = z.object({
  webUrl: z.string().url().optional(),
  webUrlUnavailableReason: z.string().optional(),
});

export const emailReferenceOutputSchema = emailWebLinkOutputSchema.extend({
  id: z.string(),
});

export const emailSummaryOutputSchema = emailWebLinkOutputSchema.extend({
  id: z.string(),
  subject: z.string(),
  from: emailAddrOutputSchema.optional(),
  to: z.array(emailAddrOutputSchema).optional(),
  receivedAt: z.string().optional(),
  preview: z.string().optional(),
  isRead: z.boolean().optional(),
  hasAttachments: z.boolean().optional(),
  folder: z.string().optional(),
  stale: z.boolean().optional(),
});

export const attachmentMetaOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  contentType: z.string().optional(),
  size: z.number().optional(),
});

export const folderInfoOutputSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  parentFolderId: z.string().optional(),
  childFolderCount: z.number(),
  totalItemCount: z.number(),
  unreadItemCount: z.number(),
});

// ── body composition helpers ──

export interface ComposeBodyInput {
  body: string;
  signature?: string;
  style?: { fontFamily?: string; fontSize?: string; fontColor?: string };
  includeSignature: boolean;
}


export function composeBody(
  input: ComposeBodyInput,
): { body: string; isHtml: boolean } {
  const { body, signature, style, includeSignature } = input;
  const htmlBody = markdownToHtml(body);

  const hasSignature = includeSignature && !!signature;
  const hasStyle = !!(
    style &&
    (style.fontFamily || style.fontSize || style.fontColor)
  );

  if (!hasSignature && !hasStyle) {
    return { body: htmlBody, isHtml: true };
  }

  const styleAttr = hasStyle ? buildStyleAttr(style!) : "";
  let result = hasStyle
    ? `<div style="${styleAttr}">${htmlBody}</div>`
    : htmlBody;
  if (hasSignature) result += `\n<div class="signature">${signature}</div>`;
  return { body: result, isHtml: true };
}

export function buildStyleAttr(style: {
  fontFamily?: string;
  fontSize?: string;
  fontColor?: string;
}): string {
  const parts: string[] = [];
  if (style.fontFamily) parts.push(`font-family: ${style.fontFamily}`);
  if (style.fontSize) parts.push(`font-size: ${style.fontSize}`);
  if (style.fontColor) parts.push(`color: ${style.fontColor}`);
  return parts.join("; ");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}


// ── thread boundary detection ──

/**
 * Find the boundary between the user's answer and the quoted thread in a
 * reply/forward draft. Uses three strategies in order:
 * 1. THREAD_MARKER comment (reliable, survives Graph normalization)
 * 2. Regex spacer match (flexible whitespace/tag variations)
 * 3. Pattern fallback (blockquote, Outlook signature)
 * Returns the boundary indices, or null if no thread content found.
 */
export function findThreadBoundary(
  html: string,
): { threadStart: number; answerEnd: number } | null {
  // ── Tier 1: exact THREAD_MARKER comment ──
  const markerIdx = html.indexOf(THREAD_MARKER);
  if (markerIdx !== -1) {
    // The spacer div sits just before the marker — find it so we replace
    // everything up to the spacer (keeping spacer + marker + thread).
    const before = html.slice(0, markerIdx);
    let answerEnd = before.lastIndexOf(
      '<div style="line-height:12px"><br></div>',
    );
    if (answerEnd === -1) {
      const re = /<div\s+style=["'][^"']*line-height\s*:\s*12px[^"']*["']\s*>\s*<br\s*\/?>\s*<\/div>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(before)) !== null) answerEnd = m.index;
    }
    return { threadStart: markerIdx, answerEnd: Math.max(answerEnd, 0) };
  }

  // ── Tier 2: regex spacer with flexible whitespace/attribute variations ──
  const spacerRe = /<div\s+style=["'][^"']*line-height\s*:\s*12px[^"']*["']\s*>\s*<br\s*\/?>\s*<\/div>/i;
  const spacerMatch = spacerRe.exec(html);
  if (spacerMatch) {
    return { threadStart: spacerMatch.index, answerEnd: spacerMatch.index };
  }

  // ── Tier 3: common Outlook thread patterns ──
  for (const re of [/id=["']?Signature["']?/i, /<blockquote/i]) {
    const idx = html.search(re);
    if (idx !== -1) return { threadStart: idx, answerEnd: idx };
  }

  return null;
}

// ── tool filtering ──

/** Returns true when `name` should be registered given the tool filtering config. */
export function shouldRegister(
  name: string,
  tools: ResolvedTools,
): boolean {
  if (tools.enabledTools) {
    return tools.enabledTools.has(name);
  }
  if (tools.disabledTools) {
    return !tools.disabledTools.has(name);
  }
  return true;
}
