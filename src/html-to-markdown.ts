import TurndownService from "turndown";

const turndown = new TurndownService();

/** Light wrapper — callers just pass HTML, get markdown back. */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

/** Pick the right body for the requested format. */
export function selectBody(
  msg: { bodyHtml?: string; bodyText?: string },
  format: "markdown" | "html",
): string {
  switch (format) {
    case "markdown": {
      if (msg.bodyHtml) return htmlToMarkdown(msg.bodyHtml);
      if (msg.bodyText) return msg.bodyText;
      return "";
    }
    case "html": {
      if (msg.bodyHtml) return msg.bodyHtml;
      if (msg.bodyText) return msg.bodyText;
      return "";
    }
  }
}
