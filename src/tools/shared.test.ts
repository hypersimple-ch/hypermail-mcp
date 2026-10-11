import { describe, expect, it } from "vitest";

import {
  emailReferenceOutputSchema,
  emailSummaryOutputSchema,
  errMsg,
} from "./shared.js";

describe("errMsg", () => {
  it("passes through unrelated errors", () => {
    expect(errMsg(new Error("boom"))).toBe("boom");
  });
});

describe("email web link schemas", () => {
  it("accepts a native web URL on email results", () => {
    expect(
      emailSummaryOutputSchema.parse({
        id: "message-1",
        subject: "Subject",
        webUrl: "https://mail.example.com/message/1",
      }),
    ).toEqual({
      id: "message-1",
      subject: "Subject",
      webUrl: "https://mail.example.com/message/1",
    });
  });

  it("accepts a per-email unavailable reason", () => {
    expect(
      emailReferenceOutputSchema.parse({
        id: "message-1",
        webUrlUnavailableReason: "Native webmail links are unavailable.",
      }),
    ).toEqual({
      id: "message-1",
      webUrlUnavailableReason: "Native webmail links are unavailable.",
    });
  });
});
