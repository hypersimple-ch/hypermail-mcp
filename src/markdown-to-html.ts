import { marked } from "marked";

/** Convert Markdown to HTML, rejecting raw HTML in authored content. */
export function markdownToHtml(md: string): string {
  const tokens = marked.lexer(md);
  marked.walkTokens(tokens, (token) => {
    if (token.type === "html") {
      throw new Error("Raw HTML is not supported. Use Markdown for email content.");
    }
  });
  return marked.parser(tokens, { async: false });
}
