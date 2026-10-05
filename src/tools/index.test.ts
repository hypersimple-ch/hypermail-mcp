import { describe, it, expect } from "vitest";
import {
  composeBody,
  escapeHtml,
  buildStyleAttr,
  markdownToHtml,
} from "./index.js";

describe("markdownToHtml", () => {
  it("converts bold text", () => {
    const result = markdownToHtml("Hello **world**");
    expect(result).toContain("<strong>world</strong>");
  });

  it("converts italic text", () => {
    const result = markdownToHtml("Hello *world*");
    expect(result).toContain("<em>world</em>");
  });

  it("converts unordered lists", () => {
    const result = markdownToHtml("- item 1\n- item 2");
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>item 1</li>");
    expect(result).toContain("<li>item 2</li>");
  });

  it("converts headings", () => {
    const result = markdownToHtml("### Title");
    expect(result).toContain("<h3>Title</h3>");
  });

  it("converts links", () => {
    const result = markdownToHtml("[example](https://example.com)");
    expect(result).toContain(
      '<a href="https://example.com">example</a>',
    );
  });

  it("converts inline code", () => {
    const result = markdownToHtml("use `code` here");
    expect(result).toContain("<code>code</code>");
  });

  it("converts blockquotes", () => {
    const result = markdownToHtml("> quoted text");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("<p>quoted text</p>");
  });

  it("returns empty string for empty input", () => {
    const result = markdownToHtml("");
    expect(result).toBe("");
  });

  it("preserves paragraphs", () => {
    const result = markdownToHtml("Line 1\n\nLine 2");
    expect(result).toContain("<p>Line 1</p>");
    expect(result).toContain("<p>Line 2</p>");
  });

  it.each([
    '<div style="color:red">Bonjour</div>',
    "Bonjour <span>vous</span>",
    "- <b>x</b>",
    "> <b>x</b>",
    "<!-- comment -->",
  ])("rejects raw HTML: %s", (body) => {
    expect(() => markdownToHtml(body)).toThrow(
      new Error("Raw HTML is not supported. Use Markdown for email content."),
    );
  });

  it.each([
    ["`<b>x</b>`", "<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>\n"],
    ["```\n<b>x</b>\n```", "<pre><code>&lt;b&gt;x&lt;/b&gt;\n</code></pre>\n"],
    ["<alice@example.com>", '<p><a href="mailto:alice@example.com">alice@example.com</a></p>\n'],
    ["2 < 3", "<p>2 &lt; 3</p>\n"],
    ["&lt;b&gt;", "<p>&lt;b&gt;</p>\n"],
    ["Line 1\nLine 2", "<p>Line 1\nLine 2</p>\n"],
  ])("preserves Markdown literals: %s", (body, html) => {
    expect(markdownToHtml(body)).toBe(html);
  });
});

describe("escapeHtml", () => {
  it("escapes HTML special chars", () => {
    expect(escapeHtml('<script>alert("hi")</script>')).toBe(
      "&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;",
    );
  });

  it("replaces newlines with <br>", () => {
    expect(escapeHtml("line 1\nline 2\n\nline 3")).toBe(
      "line 1<br>line 2<br><br>line 3",
    );
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("buildStyleAttr", () => {
  it("builds single property", () => {
    expect(buildStyleAttr({ fontFamily: "Arial" })).toBe("font-family: Arial");
  });

  it("builds multiple properties", () => {
    expect(
      buildStyleAttr({
        fontFamily: "Arial",
        fontSize: "12pt",
        fontColor: "#333333",
      }),
    ).toBe("font-family: Arial; font-size: 12pt; color: #333333");
  });

  it("returns empty string for empty style", () => {
    expect(buildStyleAttr({})).toBe("");
  });

  it("skips falsy values", () => {
    expect(buildStyleAttr({ fontFamily: "", fontSize: "12pt" })).toBe(
      "font-size: 12pt",
    );
  });
});

describe("composeBody", () => {
  it("converts paragraphs and emphasis to HTML", () => {
    expect(composeBody({
      body: "Bonjour **Alice**\n\nMerci.",
      includeSignature: false,
    })).toEqual({
      body: "<p>Bonjour <strong>Alice</strong></p>\n<p>Merci.</p>\n",
      isHtml: true,
    });
  });

  it("preserves the saved HTML signature, including inline images", () => {
    const signature = '<div><img src="cid:logo"></div>';
    expect(composeBody({
      body: "Hello **world**",
      signature,
      includeSignature: true,
    }).body).toBe(
      `<p>Hello <strong>world</strong></p>\n\n<div class="signature">${signature}</div>`,
    );
  });

  it("applies styles independently of signature inclusion", () => {
    expect(composeBody({
      body: "Hello",
      signature: "<b>John</b>",
      style: { fontFamily: "Arial", fontSize: "12pt", fontColor: "#333333" },
      includeSignature: false,
    }).body).toBe(
      '<div style="font-family: Arial; font-size: 12pt; color: #333333"><p>Hello</p>\n</div>',
    );
  });

  it("applies styles before appending the saved signature", () => {
    expect(composeBody({
      body: "Hello",
      signature: "<b>John</b>",
      style: { fontFamily: "Arial" },
      includeSignature: true,
    }).body).toBe(
      '<div style="font-family: Arial"><p>Hello</p>\n</div>\n<div class="signature"><b>John</b></div>',
    );
  });

  it("handles empty content with a saved signature", () => {
    expect(composeBody({
      body: "",
      signature: "<b>John</b>",
      includeSignature: true,
    }).body).toBe('\n<div class="signature"><b>John</b></div>');
  });

  it.each(["", undefined])("omits absent signatures: %s", (signature) => {
    expect(composeBody({
      body: "Hello",
      signature,
      includeSignature: true,
    })).toEqual({ body: "<p>Hello</p>\n", isHtml: true });
  });
});
