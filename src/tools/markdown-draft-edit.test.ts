import { expect, it } from "vitest";
import { applyMarkdownDraftEdit } from "./markdown-draft-edit.js";
import { htmlToMarkdown } from "../html-to-markdown.js";
const options = { includeSignature: false };
it.each([
  ['<p>Bonjour Alice.</p>', 'Alice', '**Bob**', '<p>Bonjour <strong>Bob</strong>.</p>'],
  ['<p>Bonjour <strong>Alice</strong>.</p>', '**Alice**', 'Bob', '<p>Bonjour Bob.</p>'],
  ['<p>Bonjour <strong>Alice</strong>.</p>', 'Alice', 'Bob', '<p>Bonjour <strong>Bob</strong>.</p>'],
  ['<p>A &amp; B 😀.</p>', '&', 'et', '<p>A et B 😀.</p>'],
  ['<p>A 😀 B.</p>', '😀', '😎', '<p>A 😎 B.</p>'],
  ['<p>A   B.</p>', 'A B', 'C', '<p>C.</p>'],
  ['<p><a href="https://example.com">Alice</a></p>', '[Alice](https://example.com)', 'Bob', '<p>Bob</p>'],
  ['<p><a href="https://example.com">Alice</a></p>', 'Alice', 'Bob', '<p><a href="https://example.com">Bob</a></p>'],
  ['<ul><li>Hello Alice</li></ul>', 'Alice', 'Bob', '<ul><li>Hello Bob</li></ul>'],
  ['<blockquote><p>Hello Alice</p></blockquote>', 'Alice', 'Bob', '<blockquote><p>Hello Bob</p></blockquote>'],
  ['<p>A</p><p>B</p>', 'A\n\nB', 'C\n\nD', '<p>C</p>\n<p>D</p>\n'],
  ['<p>Merci.</p><p>History</p>', 'Merci.', 'Merci **beaucoup**.\n\nÀ bientôt.', '<p>Merci <strong>beaucoup</strong>.</p>\n<p>À bientôt.</p>\n<p>History</p>'],
  ['<p>Hello Alice.</p>', 'Alice', '', '<p>Hello .</p>'],
])('preserves unselected HTML %#', (html, oldText, newText, expected) => {
  const tail = '<div class="signature">Signature</div><!--thread--><blockquote>History</blockquote>';
  expect(applyMarkdownDraftEdit(html + tail, oldText, newText, options)).toBe(expected + tail);
});
it.each([
  ['<p>A</p>', '', 'empty'],
  ['<p>A</p>', 'B', 'not found'],
  ['<p>aaaa</p>', 'aa', 'multiple'],
  ['<p><strong>Alice</strong></p>', '*Alice', 'cannot be mapped'],
])('rejects unsafe selections %#', (html, oldText, error) => {
  expect(() => applyMarkdownDraftEdit(html, oldText, 'Bob', options)).toThrow(error);
});
it('rejects block replacement and signature inside a phrase', () => {
  expect(() => applyMarkdownDraftEdit('<p>Hello Alice.</p>', 'Alice', 'B\n\nC', options)).toThrow('Inline selections');
  expect(() => applyMarkdownDraftEdit('<p>Hello Alice.</p>', 'Alice', 'B', { includeSignature: true })).toThrow('Inline selections');
});
it('accepts a complete list and quote in their full context', () => {
  for (const html of ['<ul><li>A</li><li>B</li></ul>', '<blockquote><p>A</p><p>B</p></blockquote>']) {
    expect(htmlToMarkdown(applyMarkdownDraftEdit(html, htmlToMarkdown(html), 'C', options))).toBe('C');
  }
});
