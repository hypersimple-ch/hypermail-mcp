import { parse, type DefaultTreeAdapterMap } from "parse5";

export type HtmlNode = DefaultTreeAdapterMap["node"];
export type HtmlElement = DefaultTreeAdapterMap["element"];
export const blockTags = new Set("p div blockquote ul ol li h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr hr pre".split(" "));
export function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}
export function parseDraftHtml(html: string) {
  return parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false });
}
function attributes(node: HtmlElement) {
  return node.attrs.map(a => [a.namespace ?? "", a.prefix ?? "", a.name, a.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function canonical(node: HtmlNode, preserve = false): unknown {
  if (node.nodeName === "#documentType") return undefined;
  if ("value" in node) return ["text", node.value.replace(/\r\n?/g, "\n")];
  if ("data" in node) return ["comment", node.data];
  if (!("childNodes" in node)) return [node.nodeName];
  if (isElement(node)) {
    const style = node.attrs.find(a => a.name === "style")?.value ?? "";
    const whiteSpace = /(?:^|;)\s*white-space\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim().toLowerCase();
    preserve ||= ["pre", "code", "textarea"].includes(node.tagName) || (whiteSpace !== undefined && whiteSpace !== "normal");
  }
  const children = (node.childNodes ?? []).filter((child, index, siblings) => {
    if (isElement(node) && node.tagName === "head" && isElement(child) && child.tagName === "meta") {
      if (child.attrs.length === 1 && child.attrs[0]?.name === "charset") return false;
      if (child.attrs.length === 2 && child.attrs.some(a => a.name === "http-equiv" && a.value.toLowerCase() === "content-type") && child.attrs.some(a => a.name === "content" && /^text\/html;\s*charset=[\w-]+$/i.test(a.value))) return false;
    }
    if (preserve || !("value" in child) || !/^[\t\n\r\f ]*$/.test(child.value)) return true;
    const before = siblings[index - 1];
    const after = siblings[index + 1];
    if (isElement(node) && node.tagName === "body" && (!before || !after)) return false;
    return !(before && after && isElement(before) && isElement(after) && blockTags.has(before.tagName) && blockTags.has(after.tagName));
  }).map(child => canonical(child, preserve)).filter(child => child !== undefined);
  if (!isElement(node)) return [node.nodeName, children];
  const content = node.tagName === "template" && "content" in node ? canonical(node.content, preserve) : children;
  return [node.tagName, node.namespaceURI, attributes(node), content];
}

/** Compare the entire body; only known provider serialization changes are ignored. */
export function draftBodiesEquivalent(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  return JSON.stringify(canonical(parseDraftHtml(actual))) === JSON.stringify(canonical(parseDraftHtml(expected)));
}
