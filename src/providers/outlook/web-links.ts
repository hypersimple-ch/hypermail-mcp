import type { Client } from "@microsoft/microsoft-graph-client";
import type { EmailWebLinkFields } from "../types.js";

export const OUTLOOK_IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

type ExchangeIdSource = "restImmutableEntryId" | "restId";

interface TranslateExchangeIdsResponse {
  value?: Array<{ sourceId?: string; targetId?: string }>;
}

interface OutlookLinkInput {
  id: string;
  graphWebLink?: string;
}

const WEB_LINK_UNAVAILABLE = "Microsoft Graph did not return an Outlook web link for this message.";
const DEFAULT_OUTLOOK_ORIGIN = "https://outlook.office365.com";

function nativeLink(graphWebLink?: string): string | undefined {
  const value = graphWebLink?.trim();
  return value || undefined;
}

/**
 * Graph can return a webLink containing the immutable ID when the request uses
 * Prefer: IdType="ImmutableId", but OWA deep links expect Graph's default REST
 * ID. Preserve Graph's account-aware origin and other routing parameters while
 * replacing every ID location used by current and legacy Outlook URLs.
 */
function outlookWebLink(restId: string, graphWebLink?: string): string {
  const graphUrl = nativeLink(graphWebLink);
  let origin = DEFAULT_OUTLOOK_ORIGIN;

  if (graphUrl) {
    try {
      const parsed = new URL(graphUrl);
      if (parsed.protocol === "https:") {
        origin = parsed.origin;
        let replaced = false;
        for (const key of [...parsed.searchParams.keys()]) {
          if (key.toLowerCase() === "itemid") {
            parsed.searchParams.set(key, restId);
            replaced = true;
          }
        }

        const deepLinkPattern = /(\/mail\/deeplink\/read\/)[^/?#]+/i;
        if (deepLinkPattern.test(parsed.pathname)) {
          parsed.pathname = parsed.pathname.replace(
            deepLinkPattern,
            `$1${encodeURIComponent(restId)}`,
          );
          replaced = true;
        }
        if (replaced) return parsed.toString();
      }
    } catch {
      // Use the standard Microsoft 365 Outlook origin below.
    }
  }

  const url = new URL("/owa/", origin);
  url.searchParams.set("ItemID", restId);
  url.searchParams.set("exvsurl", "1");
  url.searchParams.set("viewmodel", "ReadMessageItem");
  return url.toString();
}

/** Resolve native Outlook links in one ID-translation request. */
export async function resolveOutlookWebLinks(
  client: Client,
  messages: OutlookLinkInput[],
  sourceIdType: ExchangeIdSource = "restImmutableEntryId",
): Promise<Map<string, EmailWebLinkFields>> {
  const links = new Map<string, EmailWebLinkFields>();
  if (messages.length === 0) return links;

  try {
    const translated = new Map<string, string>();
    if (sourceIdType === "restId") {
      for (const message of messages) translated.set(message.id, message.id);
    } else {
      const result = (await client.api("/me/translateExchangeIds").post({
        inputIds: messages.map((message) => message.id),
        sourceIdType,
        targetIdType: "restId",
      })) as TranslateExchangeIdsResponse;

      for (const item of result.value ?? []) {
        if (item.sourceId && item.targetId) translated.set(item.sourceId, item.targetId);
      }
      // Some Graph-compatible test doubles and proxies omit sourceId for a
      // single input even though Microsoft Graph normally returns it.
      if (messages.length === 1 && translated.size === 0) {
        const targetId = result.value?.find((item) => item.targetId)?.targetId;
        if (targetId) translated.set(messages[0]!.id, targetId);
      }
    }

    for (const message of messages) {
      const restId = translated.get(message.id);
      if (restId) links.set(message.id, { webUrl: outlookWebLink(restId, message.graphWebLink) });
    }
  } catch {
    // Link generation is best-effort and must not affect mail operations.
  }

  for (const message of messages) {
    if (links.has(message.id)) continue;
    const webUrl = nativeLink(message.graphWebLink);
    links.set(
      message.id,
      webUrl ? { webUrl } : { webUrlUnavailableReason: WEB_LINK_UNAVAILABLE },
    );
  }

  return links;
}

/** Returns an Outlook link normalized to Graph's default REST ID format. */
export async function resolveOutlookWebLink(
  client: Client,
  id: string,
  graphWebLink?: string,
  sourceIdType: ExchangeIdSource = "restImmutableEntryId",
): Promise<EmailWebLinkFields> {
  const links = await resolveOutlookWebLinks(client, [{ id, graphWebLink }], sourceIdType);
  return links.get(id) ?? { webUrlUnavailableReason: WEB_LINK_UNAVAILABLE };
}

export function graphWebLinkFields(graphWebLink?: string): EmailWebLinkFields {
  const webUrl = nativeLink(graphWebLink);
  return webUrl ? { webUrl } : { webUrlUnavailableReason: WEB_LINK_UNAVAILABLE };
}
