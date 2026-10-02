import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerComposeTools } from "./compose.js";
import { sendEmailSchema } from "./compose-schemas.js";
import type { ResolvedTools } from "../config.js";
import type { EmailProvider } from "../providers/types.js";
import type { Registry } from "../providers/registry.js";
import type { AccountRecord, AccountStore } from "../store/account-store.js";
import { createLogger, type Logger } from "../logger.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const tools: ResolvedTools = {
  enabledTools: new Set(["send_email", "draft_email", "edit_draft", "send_draft"]),
  disabledTools: null,
};

const account: AccountRecord = {
  email: "user@example.com",
  provider: "outlook",
  tokens: {},
  addedAt: "2026-01-01T00:00:00.000Z",
};

function registerHandler(
  provider: EmailProvider,
  toolName = "edit_draft",
  logger?: Logger,
): Handler {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
    }),
  };
  const registry = {
    resolveByEmail: vi.fn(() => ({ provider, account })),
  } as unknown as Registry;

  registerComposeTools(server as never, {
    store: {} as AccountStore,
    registry,
    tools,
    logger,
  });

  const handler = handlers.get(toolName);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

function structured(result: unknown): Record<string, unknown> | undefined {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
}

function errorText(result: unknown): string | undefined {
  return (result as { content?: Array<{ text: string }> }).content?.[0]?.text;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("draft_email", () => {
  it("returns draftHtml when readback succeeds", async () => {
    const provider = {
      id: "outlook",
      saveDraft: vi.fn(async () => ({ id: "draft-1", webUrl: "https://mutation.example/draft-1" })),
      readEmail: vi.fn(async () => ({
        id: "draft-1-final",
        subject: "Subject",
        bodyHtml: "<p>Draft body</p>",
        webUrl: "https://mail.example/draft-1-final",
      })),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider, "draft_email");

    const result = await handler({
      account: account.email,
      to: [{ address: "recipient@example.com" }],
      subject: "Subject",
      body: "Draft body",
      format: "markdown",
      include_signature: false,
      inReplyTo: false,
    });

    expect(provider.saveDraft).toHaveBeenCalledWith(
      account,
      expect.objectContaining({
        subject: "Subject",
        body: expect.stringContaining("Draft body"),
        isHtml: true,
        inReplyTo: false,
      }),
    );
    expect(provider.readEmail).toHaveBeenCalledWith(account, "draft-1");
    expect(structured(result)).toMatchObject({
      draft: true,
      id: "draft-1-final",
      webUrl: "https://mail.example/draft-1-final",
      draftHtml: "<p>Draft body</p>",
    });
  });

  it("normalizes inReplyTo \"false\" when forwarding", async () => {
    const provider = {
      id: "outlook",
      saveDraft: vi.fn(async () => ({ id: "draft-1" })),
      readEmail: vi.fn(async () => ({
        id: "draft-1",
        bodyHtml: "<p>Draft body</p>",
      })),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider, "draft_email");
    const args = sendEmailSchema.parse({
      account: account.email,
      to: [{ address: "recipient@example.com" }],
      subject: "Forwarded subject",
      body: "Forwarded body",
      format: "markdown",
      include_signature: false,
      inReplyTo: "false",
      forwardMessageId: "message-to-forward",
    });

    const result = await handler(args);

    expect(result).not.toMatchObject({ isError: true });
    expect(provider.saveDraft).toHaveBeenCalledWith(
      account,
      expect.objectContaining({
        inReplyTo: false,
        forwardMessageId: "message-to-forward",
      }),
    );
  });

  it("returns the mutation link with a warning when draft readback fails", async () => {
    const provider = {
      id: "outlook",
      saveDraft: vi.fn(async () => ({
        id: "draft-1",
        webUrlUnavailableReason: "Provider does not expose a sent-item link.",
      })),
      readEmail: vi.fn(async () => {
        throw new Error("Id is malformed.");
      }),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider, "draft_email");

    const result = await handler({
      account: account.email,
      to: [{ address: "recipient@example.com" }],
      subject: "Subject",
      body: "Draft body",
      format: "markdown",
      include_signature: false,
      inReplyTo: false,
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(provider.readEmail).toHaveBeenCalledWith(account, "draft-1");
    expect(structured(result)).toMatchObject({
      draft: true,
      id: "draft-1",
      warning: expect.stringContaining("Draft was created"),
      draftReadbackError: "Id is malformed.",
      webUrlUnavailableReason: "Provider does not expose a sent-item link.",
    });
  });

  it("emits sanitized debug logs for draft readback failures", async () => {
    const lines: string[] = [];
    const logger = createLogger({ enabled: true, write: (line) => lines.push(line) });
    const provider = {
      id: "outlook",
      saveDraft: vi.fn(async () => ({ id: "draft-1" })),
      readEmail: vi.fn(async () => {
        throw new Error("Id is malformed.");
      }),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider, "draft_email", logger);

    const result = await handler({
      account: account.email,
      to: [{ address: "recipient@example.com" }],
      subject: "Secret subject should not be logged",
      body: "SECRET BODY SHOULD NOT BE LOGGED",
      format: "markdown",
      include_signature: false,
      inReplyTo: false,
    });

    expect(structured(result)).toMatchObject({ draft: true, id: "draft-1" });
    const logText = lines.join("\n");
    expect(logText).not.toContain("SECRET BODY");
    expect(logText).not.toContain("Secret subject");
    const events = lines.map((line) =>
      (JSON.parse(line.replace(/^\[hypermail-mcp\] debug /, "")) as { event: string }).event,
    );
    expect(events).toEqual(expect.arrayContaining([
      "start",
      "composed",
      "attachmentsProcessed",
      "providerActionSuccess",
      "draftReadbackError",
    ]));
  });
});

describe("send_email and send_draft", () => {
  it("uses only the provider result link for replies and forwards", async () => {
    const provider = {
      id: "outlook",
      sendEmail: vi.fn(async (_account: AccountRecord, input) => ({
        id: input.inReplyTo ? "reply-result" : "forward-result",
        webUrl: input.inReplyTo
          ? "https://mail.example/result/reply"
          : "https://mail.example/result/forward",
      })),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider, "send_email");

    const reply = await handler({
      account: account.email,
      to: [{ address: "recipient@example.com" }],
      subject: "Reply",
      body: "Reply body",
      format: "markdown",
      include_signature: false,
      inReplyTo: "source-message-with-https://mail.example/source",
    });
    const forward = await handler({
      account: account.email,
      to: [{ address: "recipient@example.com" }],
      subject: "Forward",
      body: "Forward body",
      format: "markdown",
      include_signature: false,
      inReplyTo: false,
      forwardMessageId: "source-message-with-https://mail.example/source",
    });

    expect(structured(reply)).toMatchObject({
      id: "reply-result",
      webUrl: "https://mail.example/result/reply",
    });
    expect(structured(forward)).toMatchObject({
      id: "forward-result",
      webUrl: "https://mail.example/result/forward",
    });
    expect(JSON.stringify(structured(reply))).not.toContain("source");
    expect(JSON.stringify(structured(forward))).not.toContain("source");
  });

  it("keeps an unresolvable Outlook-style send successful", async () => {
    const provider = {
      id: "outlook",
      sendEmail: vi.fn(async () => ({
        id: "",
        webUrlUnavailableReason: "Outlook did not return a resolvable sent item.",
      })),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider, "send_email");

    const result = await handler({
      account: account.email,
      to: [{ address: "recipient@example.com" }],
      subject: "Subject",
      body: "Body",
      format: "markdown",
      include_signature: false,
      inReplyTo: false,
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(structured(result)).toEqual({
      sent: true,
      id: "",
      webUrlUnavailableReason: "Outlook did not return a resolvable sent item.",
    });
  });

  it("returns the provider result link when sending a draft", async () => {
    const provider = {
      id: "outlook",
      sendDraft: vi.fn(async () => ({
        id: "sent-1",
        webUrl: "https://mail.example/sent-1",
      })),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider, "send_draft");

    const result = await handler({ account: account.email, id: "draft-1" });

    expect(structured(result)).toEqual({
      sent: true,
      id: "sent-1",
      webUrl: "https://mail.example/sent-1",
    });
  });
});

describe("edit_draft", () => {
  it("replaces only old_text and preserves reply history", async () => {
    const originalHtml =
      "<p>Old answer</p><div style=\"line-height:12px\"><br></div><blockquote>Older thread</blockquote>";
    let currentHtml = originalHtml;
    const provider = {
      id: "outlook",
      readEmail: vi.fn(async () => ({
        id: "draft-1",
        subject: "Subject",
        bodyHtml: currentHtml,
        webUrl: "https://mail.example/draft-1-final",
      })),
      updateDraft: vi.fn(async (_account: AccountRecord, id: string, update) => {
        currentHtml = update.body ?? currentHtml;
        return { id, webUrl: "https://mutation.example/draft-1" };
      }),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider);

    const result = await handler({
      account: account.email,
      id: "draft-1",
      old_text: "<p>Old answer</p>",
      new_text: "<p>New answer</p>",
      format: "html",
    });

    expect(provider.updateDraft).toHaveBeenCalledWith(
      account,
      "draft-1",
      expect.objectContaining({
        body:
          "<p>New answer</p><div style=\"line-height:12px\"><br></div><blockquote>Older thread</blockquote>",
        isHtml: true,
      }),
    );
    expect(structured(result)).toMatchObject({
      edited: true,
      id: "draft-1",
      webUrl: "https://mail.example/draft-1-final",
      draftHtml:
        "<p>New answer</p><div style=\"line-height:12px\"><br></div><blockquote>Older thread</blockquote>",
    });
  });

  it("rejects deprecated body without old_text", async () => {
    const provider = {
      id: "outlook",
      readEmail: vi.fn(),
      updateDraft: vi.fn(),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider);

    const result = await handler({
      account: account.email,
      id: "draft-1",
      body: "<p>Replace everything</p>",
      format: "html",
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorText(result)).toContain("Body-only full replacement is no longer supported");
    expect(provider.readEmail).not.toHaveBeenCalled();
    expect(provider.updateDraft).not.toHaveBeenCalled();
  });

  it("rejects ambiguous old_text matches", async () => {
    const provider = {
      id: "outlook",
      readEmail: vi.fn(async () => ({
        id: "draft-1",
        subject: "Subject",
        bodyHtml: "<p>Same</p><p>Same</p><blockquote>history</blockquote>",
      })),
      updateDraft: vi.fn(),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider);

    const result = await handler({
      account: account.email,
      id: "draft-1",
      old_text: "<p>Same</p>",
      new_text: "<p>Updated</p>",
      format: "html",
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorText(result)).toContain("old_text matched multiple sections");
    expect(provider.updateDraft).not.toHaveBeenCalled();
  });

  it("rejects multiline plain text replacements passed as HTML", async () => {
    const provider = {
      id: "outlook",
      readEmail: vi.fn(async () => ({
        id: "draft-1",
        subject: "Subject",
        bodyHtml: "<p>Old answer</p>",
      })),
      updateDraft: vi.fn(),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider);

    const result = await handler({
      account: account.email,
      id: "draft-1",
      old_text: "<p>Old answer</p>",
      new_text: "Line 1\n\nLine 2",
      format: "html",
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorText(result)).toContain('format: "html" requires valid HTML');
    expect(provider.updateDraft).not.toHaveBeenCalled();
  });

  it("fails when a body edit is not observable after saving", async () => {
    vi.useFakeTimers();
    const provider = {
      id: "gmail",
      readEmail: vi.fn(async () => ({
        id: "draft-1",
        subject: "Subject",
        bodyHtml: "<p>Old answer</p>",
      })),
      updateDraft: vi.fn(async (_account: AccountRecord, id: string) => ({ id })),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider);

    const pending = handler({
      account: account.email,
      id: "draft-1",
      old_text: "<p>Old answer</p>",
      new_text: "<p>New answer</p>",
      format: "html",
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ isError: true });
    expect(errorText(result)).toContain("Draft body edit was not observable");
    expect(structured(result)).toBeUndefined();
  });

  it("replays Outlook body updates after stale attachment handling", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "hypermail-compose-test-"));
    const filePath = join(dir, "note.txt");
    writeFileSync(filePath, "attachment");

    try {
      const originalHtml = "<p>Old answer</p>";
      const updatedHtml = "<p>New answer</p>";
      let currentHtml = originalHtml;
      let updateCalls = 0;
      const provider = {
        id: "outlook",
        readEmail: vi.fn(async () => ({
          id: "draft-1",
          subject: "Subject",
          bodyHtml: currentHtml,
        })),
        updateDraft: vi.fn(async (_account: AccountRecord, id: string, update) => {
          updateCalls += 1;
          if (updateCalls > 1) currentHtml = update.body ?? currentHtml;
          return { id };
        }),
        addAttachmentToDraft: vi.fn(async (_account, draftId: string) => ({
          id: draftId,
          attachment: { id: "att-1", name: "note.txt" },
        })),
      } as unknown as EmailProvider;
      const handler = registerHandler(provider);

      const pending = handler({
        account: account.email,
        id: "draft-1",
        old_text: originalHtml,
        new_text: updatedHtml,
        format: "html",
        new_attachments: [{ filePath }],
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(provider.addAttachmentToDraft).toHaveBeenCalled();
      expect(provider.updateDraft).toHaveBeenCalledTimes(2);
      expect(provider.updateDraft).toHaveBeenLastCalledWith(
        account,
        "draft-1",
        expect.objectContaining({ body: updatedHtml, isHtml: true }),
      );
      expect(structured(result)).toMatchObject({
        edited: true,
        id: "draft-1",
        draftHtml: updatedHtml,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not call updateDraft for attachment-only edits", async () => {
    const provider = {
      id: "outlook",
      updateDraft: vi.fn(),
      removeAttachmentsFromDraft: vi.fn(async () => ({ id: "draft-1" })),
      readEmail: vi.fn(async () => ({
        id: "draft-1",
        subject: "Subject",
        bodyHtml: "<p>Body</p>",
      })),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider);

    const result = await handler({
      account: account.email,
      id: "draft-1",
      remove_attachments: ["att-1"],
    });

    expect(provider.updateDraft).not.toHaveBeenCalled();
    expect(provider.removeAttachmentsFromDraft).toHaveBeenCalledWith(
      account,
      "draft-1",
      ["att-1"],
    );
    expect(structured(result)).toMatchObject({ edited: true, id: "draft-1" });
  });
});

describe("combined draft replacement identity", () => {
  it("removes original IDs before body edits/additions and returns final attachment metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-replacement-"));
    const path = join(dir, "new.txt"); writeFileSync(path, "new bytes");
    try {
      let current = "original"; let body = "<p>before</p>"; let attachments = [{ id: "original-remove", name: "remove.txt" }, { id: "original-keep", name: "keep.txt" }];
      const operations: string[] = [];
      const assertCurrent = (id: string) => { if (id !== current) throw new Error(`stale ID: ${id}`); };
      const provider = {
        id: "gmail",
        readEmail: async (_account: AccountRecord, id: string) => { assertCurrent(id); return { id, subject: "Subject", bodyHtml: body, attachments }; },
        removeAttachmentsFromDraft: async (_account: AccountRecord, id: string, ids: string[]) => {
          assertCurrent(id); if (ids.join(",") !== "original-remove") throw new Error("removal ID was not original");
          operations.push("remove"); current = "removed"; attachments = [{ id: "removed-keep", name: "keep.txt" }]; return { id: current };
        },
        updateDraft: async (_account: AccountRecord, id: string, update: { body?: string }) => {
          assertCurrent(id); operations.push("update"); body = update.body!; current = "updated"; attachments = [{ id: "updated-keep", name: "keep.txt" }]; return { id: current };
        },
        addAttachmentToDraft: async (_account: AccountRecord, id: string, name: string) => {
          assertCurrent(id); operations.push("add"); current = "final"; attachments = [{ id: "final-keep", name: "keep.txt" }, { id: "final-new", name }]; return { id: current, attachment: attachments[1]! };
        },
      } as unknown as EmailProvider;
      const result = await registerHandler(provider)({ account: account.email, id: "original", old_text: "before", new_text: "after", format: "html", remove_attachments: ["original-remove"], new_attachments: [{ filePath: path }] });
      expect(structured(result)).toEqual({ edited: true, id: "final", draftHtml: "<p>after</p>", attachments: [{ id: "final-keep", name: "keep.txt" }, { id: "final-new", name: "new.txt" }] });
      expect(operations).toEqual(["remove", "update", "add"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
