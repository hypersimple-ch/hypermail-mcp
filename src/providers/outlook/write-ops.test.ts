import type { Client } from "@microsoft/microsoft-graph-client";
import { describe, expect, it } from "vitest";

import { buildDraftFromReference, THREAD_MARKER, updateDraft } from "./write-ops.js";
import { removeAttachmentsFromDraft } from "./write-ops.js";

interface PatchCall {
  endpoint: string;
  payload: unknown;
  headers?: Record<string, string>;
}

class FakeGraphRequest {
  private readonly requestHeaders: Record<string, string> = {};

  constructor(
    private readonly endpoint: string,
    private readonly draftBody: { content?: string; contentType?: string },
    private readonly patches: PatchCall[],
  ) {}

  select(_fields: string): this {
    return this;
  }

  header(name: string, value: string): this {
    this.requestHeaders[name] = value;
    return this;
  }

  async post(_payload: unknown): Promise<{ id: string }> {
    return { id: "draft-1" };
  }

  async get(): Promise<{ body: { content?: string; contentType?: string } }> {
    return { body: this.draftBody };
  }

  async patch(payload: unknown): Promise<{ id: string }> {
    const call: PatchCall = { endpoint: this.endpoint, payload };
    if (Object.keys(this.requestHeaders).length > 0) {
      call.headers = { ...this.requestHeaders };
    }
    this.patches.push(call);
    return { id: "draft-1" };
  }
}

function fakeClient(draftBody: { content?: string; contentType?: string }): {
  client: Client;
  patches: PatchCall[];
} {
  const patches: PatchCall[] = [];
  const client = {
    api(endpoint: string) {
      return new FakeGraphRequest(endpoint, draftBody, patches);
    },
  } as unknown as Client;
  return { client, patches };
}

describe("updateDraft", () => {
  it("requests the updated Graph representation when patching drafts", async () => {
    const { client, patches } = fakeClient({});

    const res = await updateDraft(
      client,
      {
        email: "user@example.com",
        provider: "outlook",
        tokens: {},
        addedAt: "2026-01-01T00:00:00.000Z",
      },
      "draft-1",
      {
        subject: "Updated subject",
        body: "<p>Updated body</p>",
        isHtml: true,
      },
    );

    expect(res).toEqual({
      id: "draft-1",
      webUrlUnavailableReason: "Microsoft Graph did not return an Outlook web link for this message.",
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      endpoint: "/me/messages/draft-1",
      headers: { Prefer: 'return=representation, IdType="ImmutableId"' },
      payload: {
        subject: "Updated subject",
        body: {
          contentType: "HTML",
          content: "<p>Updated body</p>",
        },
      },
    });
  });
});

describe("buildDraftFromReference", () => {
  it("patches plain-text reply drafts as HTML and escapes the quoted text", async () => {
    const { client, patches } = fakeClient({
      contentType: "Text",
      content: "On Monday, Caroline wrote:\r\n<unsafe> & \"quoted\"",
    });

    const id = await buildDraftFromReference(
      client,
      "/me/messages/source/createReply",
      {},
      { body: "<p>Hello <strong>Caroline</strong></p>", attachments: [] },
    );

    expect(id).toBe("draft-1");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      endpoint: "/me/messages/draft-1",
      payload: {
        body: {
          contentType: "HTML",
          content:
            "<p>Hello <strong>Caroline</strong></p>" +
            '<div style="line-height:12px"><br></div>' +
            THREAD_MARKER +
            "On Monday, Caroline wrote:<br>&lt;unsafe&gt; &amp; &quot;quoted&quot;",
        },
      },
    });
  });

  it("inserts HTML replies inside existing HTML body drafts without escaping them", async () => {
    const { client, patches } = fakeClient({
      contentType: "HTML",
      content: '<html><body class="mail"><p>Existing <em>thread</em></p></body></html>',
    });

    await buildDraftFromReference(
      client,
      "/me/messages/source/createReply",
      {},
      { body: "<p>New reply</p>", attachments: [] },
    );

    expect(patches).toHaveLength(1);
    expect(patches[0]?.payload).toEqual({
      body: {
        contentType: "HTML",
        content:
          '<html><body class="mail"><p>New reply</p>' +
          '<div style="line-height:12px"><br></div>' +
          THREAD_MARKER +
          "<p>Existing <em>thread</em></p></body></html>",
      },
    });
  });

  it("normalizes plain-text history wrapped in an HTML body", async () => {
    const { client, patches } = fakeClient({
      contentType: "HTML",
      content:
        "<html><head></head><body>________________________________________\r\n" +
        "From: Caroline Masa\r\n" +
        "Sent: Friday, 26 June 2026 12:58:19\r\n" +
        "To: Physio 7 School\r\n" +
        "Subject: Déplacement date Dry Needling 12-13.9.26\r\n" +
        "Bonjour\r\n\r\n" +
        "Je suis inscrite à un cours.</body></html>",
    });

    await buildDraftFromReference(
      client,
      "/me/messages/source/createReply",
      {},
      { body: "<p>New reply</p>", attachments: [] },
    );

    expect(patches).toHaveLength(1);
    expect(patches[0]?.payload).toEqual({
      body: {
        contentType: "HTML",
        content:
          "<html><head></head><body><p>New reply</p>" +
          '<div style="line-height:12px"><br></div>' +
          THREAD_MARKER +
          '<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">' +
          "________________________________________<br>" +
          "From: Caroline Masa<br>" +
          "Sent: Friday, 26 June 2026 12:58:19<br>" +
          "To: Physio 7 School<br>" +
          "Subject: Déplacement date Dry Needling 12-13.9.26<br>" +
          "Bonjour<br><br>" +
          "Je suis inscrite à un cours.</blockquote></body></html>",
      },
    });
  });

  it("normalizes bare plain-ish HTML draft bodies", async () => {
    const { client, patches } = fakeClient({
      contentType: "HTML",
      content:
        "________________________________________\n" +
        "From: Caroline <caro.casse@hotmail.com>\n" +
        "Bonjour",
    });

    await buildDraftFromReference(
      client,
      "/me/messages/source/createReply",
      {},
      { body: "<p>New reply</p>", attachments: [] },
    );

    expect(patches).toHaveLength(1);
    expect(patches[0]?.payload).toEqual({
      body: {
        contentType: "HTML",
        content:
          "<p>New reply</p>" +
          '<div style="line-height:12px"><br></div>' +
          THREAD_MARKER +
          '<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">' +
          "________________________________________<br>" +
          "From: Caroline &lt;caro.casse@hotmail.com&gt;<br>" +
          "Bonjour</blockquote>",
      },
    });
  });
});

describe("Outlook bulk attachment deletion", () => {
  it("validates all IDs first and returns the surviving draft reference", async () => {
    const attachments = new Set(["first", "second", "retained"]);
    const events: string[] = [];
    const client = { api: (endpoint: string) => {
      const id = endpoint.split("/attachments/")[1];
      const request = {
        header: () => request, select: () => request,
        get: async () => {
          if (!id) return { id: "draft", webLink: "https://outlook.office.com/mail/draft" };
          events.push(`get:${id}`); if (!attachments.has(id)) throw new Error(`missing ${id}`); return { id };
        },
        delete: async () => { events.push(`delete:${id}`); attachments.delete(id!); },
      };
      return request;
    } } as unknown as Client;
    const account = { email: "user@example.com", provider: "outlook" as const, tokens: {}, addedAt: "2026-01-01" };
    await expect(removeAttachmentsFromDraft(client, account, "draft", ["first", "missing"])).rejects.toThrow("missing missing");
    expect([...attachments]).toEqual(["first", "second", "retained"]);
    events.length = 0;
    expect(await removeAttachmentsFromDraft(client, account, "draft", ["first", "second", "first"])).toEqual({ id: "draft", webUrl: "https://outlook.office.com/mail/draft" });
    expect([...attachments]).toEqual(["retained"]);
    expect(events).toEqual(["get:first", "get:second", "delete:first", "delete:second"]);
  });
});
