import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type * as Os from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeAttachmentFile } from "./attachment-files.js";

const state = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof Os>();
  return { ...original, tmpdir: () => state.root ?? original.tmpdir() };
});

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "hypermail-attachment-test-"));
  state.root = join(sandbox, "downloads", "temporary");
  await mkdir(state.root, { recursive: true });
});
afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
  state.root = undefined;
});

describe("attachment file isolation", () => {
  it.each([
    ["../../victim", "attachment"],
    ["..\\victim", "attachment"],
    ["report.pdf", "attachment.pdf"],
    ["report.", "attachment"],
    ["report", "attachment"],
    ["..\\folder\\report.PDF", "attachment.PDF"],
    ["report.bad-extension", "attachment"],
    ["report.abcdefghijklmnopq", "attachment"],
  ])("isolates %s and preserves only a safe extension", async (name, expectedName) => {
    const sentinel = join(sandbox, "victim");
    await writeFile(sentinel, "untouched");
    const bytes = Buffer.from([0, 1, 255]);
    const path = await writeAttachmentFile(name, bytes);
    expect(basename(path)).toBe(expectedName);
    expect(dirname(dirname(path))).toBe(state.root);
    expect(basename(dirname(path))).toMatch(/^hypermail-attachment-/);
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  it("keeps repeated names in distinct directories without overwriting", async () => {
    const [first, second] = await Promise.all([
      writeAttachmentFile("same.pdf", Buffer.from("first")),
      writeAttachmentFile("same.pdf", Readable.from([Buffer.from("second")])),
    ]);
    expect(dirname(first)).not.toBe(dirname(second));
    expect(await readFile(first, "utf8")).toBe("first");
    expect(await readFile(second, "utf8")).toBe("second");
  });

  it("removes the private directory when a stream fails, leaving other files alone", async () => {
    const sentinel = join(state.root!, "sentinel");
    await writeFile(sentinel, "untouched");
    const error = new Error("download failed");
    const content = Readable.from((async function* () {
      yield Buffer.from("partial");
      throw error;
    })());
    await expect(writeAttachmentFile("report.pdf", content)).rejects.toBe(error);
    expect(await readdir(state.root!)).toEqual(["sentinel"]);
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  });
});
