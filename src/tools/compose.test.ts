import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerComposeTools } from "./compose.js";
import { editDraftSchema, sendEmailSchema } from "./compose-schemas.js";
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

describe("Markdown-only composition", () => {
  it.each(["send_email", "draft_email"])("rejects raw HTML before %s mutates the provider", async (toolName) => {
    const provider = {
      id: "outlook",
      sendEmail: vi.fn(),
      saveDraft: vi.fn(),
      readEmail: vi.fn(),
    } as unknown as EmailProvider;
    const result = await registerHandler(provider, toolName)(sendEmailSchema.parse({
      account: account.email,
      to: [{ address: "recipient@example.com" }],
      subject: "Subject",
      body: '<div style="color:red">Bonjour</div>',
      include_signature: false,
      inReplyTo: false,
    }));
    expect(result).toMatchObject({ isError: true });
    expect(errorText(result)).toBe("Raw HTML is not supported. Use Markdown for email content.");
    expect(provider.sendEmail).not.toHaveBeenCalled();
    expect(provider.saveDraft).not.toHaveBeenCalled();
    expect(provider.readEmail).not.toHaveBeenCalled();
  });

  it.each(["new_text", "body"])("rejects HTML in %s before removing attachments", async (field) => {
    const provider = {
      id: "outlook",
      readEmail: vi.fn(async () => ({ id: "draft-1", bodyHtml: "<p>Old answer</p>" })),
      updateDraft: vi.fn(),
      removeAttachmentsFromDraft: vi.fn(),
      addAttachmentToDraft: vi.fn(),
    } as unknown as EmailProvider;
    const result = await registerHandler(provider)(editDraftSchema.parse({
      account: account.email,
      id: "draft-1",
      old_text: "Old answer",
      [field]: "Bonjour <span>vous</span>",
      remove_attachments: ["att-1"],
    }));
    expect(result).toMatchObject({ isError: true });
    expect(errorText(result)).toBe("Raw HTML is not supported. Use Markdown for email content.");
    expect(provider.updateDraft).not.toHaveBeenCalled();
    expect(provider.removeAttachmentsFromDraft).not.toHaveBeenCalled();
    expect(provider.addAttachmentToDraft).not.toHaveBeenCalled();
  });

  it("rejects absent selections without saving", async () => {
    const provider = {
      id: "outlook",
      readEmail: vi.fn(async () => ({ id: "draft-1", bodyHtml: "<p>Old answer</p>" })),
      updateDraft: vi.fn(),
    } as unknown as EmailProvider;
    const result = await registerHandler(provider)({
      account: account.email, id: "draft-1", old_text: "Missing", new_text: "New answer",
    });
    expect(result).toMatchObject({ isError: true });
    expect(errorText(result)).toContain("old_text");
    expect(provider.updateDraft).not.toHaveBeenCalled();
  });

  it("allows an empty replacement while preserving history", async () => {
    let html = "<p>Old answer</p><blockquote>Older thread</blockquote>";
    const provider = {
      id: "outlook",
      readEmail: vi.fn(async () => ({ id: "draft-1", bodyHtml: html })),
      updateDraft: vi.fn(async (_account, id, update) => {
        html = update.body ?? html;
        return { id };
      }),
    } as unknown as EmailProvider;
    const result = await registerHandler(provider)(editDraftSchema.parse({
      account: account.email, id: "draft-1", old_text: "Old answer", new_text: "",
    }));
    expect(structured(result)).toMatchObject({ edited: true, draftMarkdown: "> Older thread" });
    expect(html).toBe("<blockquote>Older thread</blockquote>");
  });
});

describe("draft_email", () => {
  it("returns authoritative Markdown and final identity when readback succeeds", async () => {
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
      draftMarkdown: "Draft body",
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
      include_signature: false,
      inReplyTo: "source-message-with-https://mail.example/source",
    });
    const forward = await handler({
      account: account.email,
      to: [{ address: "recipient@example.com" }],
      subject: "Forward",
      body: "Forward body",
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
      old_text: "Old answer",
      new_text: "New **answer**",
    });

    expect(provider.updateDraft).toHaveBeenCalledWith(
      account,
      "draft-1",
      expect.objectContaining({
        body:
          "<p>New <strong>answer</strong></p>\n<div style=\"line-height:12px\"><br></div><blockquote>Older thread</blockquote>",
        isHtml: true,
      }),
    );
    expect(structured(result)).toMatchObject({
      edited: true,
      id: "draft-1",
      webUrl: "https://mail.example/draft-1-final",
    });
    expect(structured(result)?.draftMarkdown).toContain("New **answer**");
    expect(structured(result)?.draftMarkdown).toContain("> Older thread");
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
      body: "Replace everything",
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
      old_text: "Same",
      new_text: "Updated",
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorText(result)).toContain("old_text matched multiple sections");
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
      old_text: "Old answer",
      new_text: "New answer",
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
      const updatedHtml = "<p>New answer</p>\n";
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
        old_text: "Old answer",
        new_text: "New answer",
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
        draftMarkdown: "New answer",
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
      const result = await registerHandler(provider)({ account: account.email, id: "original", old_text: "before", new_text: "after", remove_attachments: ["original-remove"], new_attachments: [{ filePath: path }] });
      expect(structured(result)).toEqual({ edited: true, id: "final", draftMarkdown: "after", attachments: [{ id: "final-keep", name: "keep.txt" }, { id: "final-new", name: "new.txt" }] });
      expect(operations).toEqual(["remove", "update", "add"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Markdown draft persistence through provider normalization", () => {
  it("edits a block and then a word without replay or losing adjacent HTML", async () => {
    const tail = '<div class="signature">Signature</div><!--thread--><blockquote>History</blockquote>';
    let html = '<p>Bonjour <strong>Alice</strong>.</p><p>Merci.</p>' + tail;
    const provider = {
      id: "outlook",
      readEmail: vi.fn(async () => ({ id: "draft", subject: "Test", bodyHtml: html })),
      updateDraft: vi.fn(async (_account, id, update) => {
        const normalized = update.body!.replace(/<\/p>\n<p>/g, "</p><p>");
        html = normalized.startsWith("<html>") ? normalized : '<html><head><meta charset="utf-8"></head><body>' + normalized + '</body></html>';
        return { id };
      }),
    } as unknown as EmailProvider;
    const handler = registerHandler(provider);
    const block = await handler({ account: account.email, id: "draft", old_text: "Merci.", new_text: "Merci **beaucoup**.\n\nÀ bientôt." });
    expect(structured(block)).toMatchObject({ edited: true, draftMarkdown: "Bonjour **Alice**.\n\nMerci **beaucoup**.\n\nÀ bientôt.\n\nSignature\n\n> History" });
    const word = await handler({ account: account.email, id: "draft", old_text: "Alice", new_text: "Bob" });
    expect(structured(word)?.draftMarkdown).toBe("Bonjour **Bob**.\n\nMerci **beaucoup**.\n\nÀ bientôt.\n\nSignature\n\n> History");
    expect(html).toContain(tail);
    expect(provider.updateDraft).toHaveBeenCalledTimes(2);
    expect(structured(word)).not.toHaveProperty("draftHtml");
  });

  it.each(["Missing", "aa", "*Alice"])("rejects absent, overlapping or unsafe selection %s before all mutations", async old_text => {
    const provider = {
      id: "outlook",
      readEmail: async () => ({ id: "draft", bodyHtml: "<p>aaaa <strong>Alice</strong></p>" }),
      updateDraft: vi.fn(),
      removeAttachmentsFromDraft: vi.fn(),
      addAttachmentToDraft: vi.fn(),
    } as unknown as EmailProvider;
    const result = await registerHandler(provider)({ account: account.email, id: "draft", old_text, new_text: "Bob", remove_attachments: ["a"], new_attachments: [{ filePath: "/missing" }] });
    expect(result).toMatchObject({ isError: true });
    expect(provider.updateDraft).not.toHaveBeenCalled();
    expect(provider.removeAttachmentsFromDraft).not.toHaveBeenCalled();
    expect(provider.addAttachmentToDraft).not.toHaveBeenCalled();
  });

  it("maps literal plain-text offsets rather than interpreting HTML or Markdown", async () => {
    let html: string | undefined;
    const text = "Hello *Alice* <tag> & witness.";
    const provider = {
      id: "gmail",
      readEmail: async () => ({ id: "draft", bodyText: text, bodyHtml: html }),
      updateDraft: async (...[_account, id, update]: Parameters<EmailProvider["updateDraft"]>) => { html = update.body; return { id }; },
    } as unknown as EmailProvider;
    const result = await registerHandler(provider)({ account: account.email, id: "draft", old_text: "*Alice*", new_text: "**Bob**" });
    expect(structured(result)).toMatchObject({ edited: true, draftMarkdown: "Hello **Bob** <tag> & witness." });
    expect(html).toBe("<p>Hello <strong>Bob</strong> &lt;tag&gt; &amp; witness.</p>");
  });
});
