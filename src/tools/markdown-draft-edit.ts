import { htmlToMarkdown } from "../html-to-markdown.js";
import { markdownToHtml } from "../markdown-to-html.js";
import { parseDraftHtml, isElement, blockTags, type HtmlNode } from "./draft-html.js";
import { composeBody, buildStyleAttr, escapeHtml, type ComposeBodyInput } from "./shared.js";

const mappingError = "old_text cannot be mapped safely to the current draft HTML; select a complete Markdown phrase or block from read_email";
const inlineError = "Inline selections require inline Markdown without a signature; select a complete block instead";
interface Boundary { source: number; markdown: number; parent: HtmlNode }
interface Range { start: number; end: number; block: boolean }

/** Locate edits using the same full-document Turndown context as read_email. */
export function applyMarkdownDraftEdit(html: string, oldText: string, newText: string, options: Omit<ComposeBodyInput, "body">): string {
  const markdown = htmlToMarkdown(html);
  if (!oldText) throw new Error("old_text must not be empty");
  const selected = markdown.indexOf(oldText);
  if (selected < 0) throw new Error("old_text was not found in the current draft body");
  if (markdown.indexOf(oldText, selected + 1) >= 0) throw new Error("old_text matched multiple sections in the current draft body; provide a more specific selection");
  const finish = selected + oldText.length;
  // Markers are plain text: they do not introduce Markdown syntax or alter ancestors.
  let marker = "HYPERMAILSELECTIONBOUNDARY";
  while (html.includes(marker) || markdown.includes(marker)) marker += "X";
  const tree = parseDraftHtml(html);
  const boundaries: Boundary[] = [];
  const ranges: Range[] = [];
  function visit(node: HtmlNode, parent: HtmlNode) {
    if ("value" in node && node.sourceCodeLocation) {
      const { startOffset, endOffset } = node.sourceCodeLocation;
      const source = html.slice(startOffset, endOffset);
      // Entities, Unicode scalars and collapsed whitespace runs are indivisible.
      const atoms = source.match(/&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][\w]+);?|[\t\n\r\f ]+|[\s\S]/gu) ?? [];
      let offset = startOffset;
      for (const atom of ["", ...atoms]) {
        offset += atom.length;
        const projected = htmlToMarkdown(html.slice(0, offset) + marker + html.slice(offset));
        const at = projected.indexOf(marker);
        if (at >= 0 && projected.slice(0, at) + projected.slice(at + marker.length) === markdown) {
          boundaries.push({ source: offset, markdown: at, parent });
        }
      }
    }
    if (!("childNodes" in node)) return;
    const children = node.childNodes ?? [];
    // Complete sibling elements may include inline nodes or multiple blocks.
    for (let i = 0; i < children.length; i++) {
      const first = children[i];
      if (!first || !isElement(first) || !first.sourceCodeLocation) continue;
      for (let j = i; j < children.length; j++) {
        const last = children[j];
        if (!last || !isElement(last) || !last.sourceCodeLocation) continue;
        const start = first.sourceCodeLocation.startOffset;
        const end = last.sourceCodeLocation.endOffset;
        if (!first.sourceCodeLocation.startTag || !last.sourceCodeLocation.endTag && last.tagName !== "hr" && last.tagName !== "img" && last.tagName !== "br") continue;
        const projected = htmlToMarkdown(html.slice(0, start) + marker + html.slice(end));
        const at = projected.indexOf(marker);
        if (at < 0) continue;
        const block = blockTags.has(first.tagName) && blockTags.has(last.tagName);
        const prefix = projected.slice(0, at);
        const suffix = projected.slice(at + marker.length);
        const matches = block
          ? prefix.trimEnd() === markdown.slice(0, selected).trimEnd() && suffix.trimStart() === markdown.slice(finish).trimStart()
          : prefix === markdown.slice(0, selected) && suffix === markdown.slice(finish);
        if (matches) ranges.push({ start, end, block });
      }
    }
    for (const child of children) visit(child, node);
  }
  visit(tree, tree);
  const structuralRanges = [...ranges].sort((a, b) => a.end - a.start - (b.end - b.start));
  for (const start of boundaries.filter(b => b.markdown === selected)) {
    for (const end of boundaries.filter(b => b.markdown === finish)) {
      if (start.parent === end.parent && start.source <= end.source) ranges.push({ start: start.source, end: end.source, block: false });
    }
  }
  ranges.sort((a, b) => a.end - a.start - (b.end - b.start));
  const candidate = structuralRanges[0] ?? ranges[0];
  if (!candidate || ranges.some(r => !(r.start <= candidate.start && r.end >= candidate.end) && !(r.start >= candidate.start && r.end <= candidate.end))) throw new Error(mappingError);
  const range: Range = candidate;
  const replacement = renderReplacement(newText, options, range.block);
  const result = html.slice(0, range.start) + replacement + html.slice(range.end);
  // Surviving source elements must retain their exact parent chain after parsing.
  const surviving = new Map<number, string>();
  function ancestry(node: HtmlNode, path: string[], output: Map<number, string>, original: boolean) {
    if (isElement(node)) {
      const location = node.sourceCodeLocation;
      if (location && ( !original || location.startOffset < range.start || location.startOffset >= range.end)) {
        const offset = original && location.startOffset >= range.end ? location.startOffset + replacement.length - (range.end - range.start) : location.startOffset;
        output.set(offset, [...path, node.tagName].join("/"));
      }
      path = [...path, node.tagName];
    }
    if ("childNodes" in node) for (const child of node.childNodes ?? []) ancestry(child, path, output, original);
  }
  ancestry(tree, [], surviving, true);
  const actual = new Map<number, string>();
  ancestry(parseDraftHtml(result), [], actual, false);
  if ([...surviving].some(([offset, path]) => actual.get(offset) !== path)) throw new Error(mappingError);
  return result;
}

function renderReplacement(newText: string, options: Omit<ComposeBodyInput, "body">, block: boolean): string {
  if (block) return composeBody({ ...options, body: newText }).body;
  const rendered = markdownToHtml(newText);
  const parsed = parseDraftHtml(rendered);
  const body = parsed.childNodes.find(isElement)?.childNodes.find(n => isElement(n) && n.tagName === "body");
  const children = body && "childNodes" in body ? (body.childNodes ?? []).filter(n => !("value" in n && !n.value.trim())) : [];
  const paragraph = children[0];
  if (options.includeSignature || (newText !== "" && (children.length !== 1 || !paragraph || !isElement(paragraph) || paragraph.tagName !== "p"))) throw new Error(inlineError);
  let replacement = "";
  if (paragraph && isElement(paragraph)) {
    const containsBlock = (n: HtmlNode): boolean => isElement(n) && blockTags.has(n.tagName) || "childNodes" in n && (n.childNodes ?? []).some(containsBlock);
    if (paragraph.childNodes.some(containsBlock)) throw new Error(inlineError);
    replacement = rendered.slice(paragraph.sourceCodeLocation!.startTag!.endOffset, paragraph.sourceCodeLocation!.endTag!.startOffset);
  }
  const style = options.style && buildStyleAttr(options.style);
  return style && replacement ? `<span style="${style}">${replacement}</span>` : replacement;
}

/** Plain-text messages are literal text, not HTML or Markdown source. */
export function applyPlainTextDraftEdit(text: string, oldText: string, newText: string, options: Omit<ComposeBodyInput, "body">): string {
  if (!oldText) throw new Error("old_text must not be empty");
  const start = text.indexOf(oldText);
  if (start < 0) throw new Error("old_text was not found in the current draft body");
  if (text.indexOf(oldText, start + 1) >= 0) throw new Error("old_text matched multiple sections in the current draft body; provide a more specific selection");
  const end = start + oldText.length;
  const splitsSurrogate = (at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
  if (splitsSurrogate(start) || splitsSurrogate(end)) throw new Error(mappingError);
  if (start === 0 && end === text.length) return renderReplacement(newText, options, true);
  const html = `<p>${escapeHtml(text)}</p>`;
  const htmlStart = 3 + escapeHtml(text.slice(0, start)).length;
  const htmlEnd = 3 + escapeHtml(text.slice(0, end)).length;
  return html.slice(0, htmlStart) + renderReplacement(newText, options, false) + html.slice(htmlEnd);
}
