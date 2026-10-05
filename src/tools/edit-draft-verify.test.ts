import { describe, expect, it } from "vitest";
import { bodyEditPersisted } from "./edit-draft-verify.js";

describe("complete draft persistence", () => {
  it.each([
    ['<html><head><meta charset="utf-8"></head><body><p>New</p><p>History</p></body></html>', '<p>New</p>\n<p>History</p>', true],
    ['<p>A\r\nB</p>', '<p>A\nB</p>', true],
    ['<p>New</p>', '<p>New</p><p>History</p>', false],
    ['', '<p>History</p>', false],
    ['<p>Old and new</p>', '<p>Old and new</p>', true],
    ['<body><p>Old and new</p></body>', '<p>Old and new</p><p>History</p>', false],
    ['<a href="a">X</a>', '<a href="b">X</a>', false],
    ['<img src="cid:a">', '<img src="cid:b">', false],
    ['<p style="color:red">X</p>', '<p style="color:blue">X</p>', false],
    ['<!--a--><p>X</p>', '<!--b--><p>X</p>', false],
    ['<b>A</b> <i>B</i>', '<b>A</b><i>B</i>', false],
    ['<pre>A B</pre>', '<pre>A  B</pre>', false],
    ['<code>A\nB</code>', '<code>AB</code>', false],
    ['<div style="white-space: pre"><p>A</p>\n<p>B</p></div>', '<div style="white-space: pre"><p>A</p><p>B</p></div>', false],
    ['<head><style>p{color:red}</style></head><p>X</p>', '<p>X</p>', false],
    ['<body class="x"><p>X</p></body>', '<p>X</p>', false],
  ])("compares complete provider bodies %#", (actual, expectedBody, persisted) => {
    expect(bodyEditPersisted(actual as string, { expectedBody: expectedBody as string })).toBe(persisted);
  });
});
