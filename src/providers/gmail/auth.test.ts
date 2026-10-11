import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  beginAuthorizationCode,
  completeAuthorizationCode,
} from "./auth.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Gmail authorization-code OAuth", () => {
  const defaultClientId =
    "402846182885-uucmvo5gbgd0u2m49hk2k3ng6vtemuql.apps.googleusercontent.com";
  // Fingerprint only: assertion failures must not reveal the distributed credential.
  const defaultSecretIdentity =
    "02ca9f2c5a2fdc5797a2948756101bca494e63ae7934a90cb9ed060d34e3530f";
  const identity = (secret: string | null | undefined) =>
    createHash("sha256").update(secret ?? "").digest("hex");

  const blankInputs = [undefined, "", " \t "];
  const cases = [
    ...blankInputs.flatMap((clientId) =>
      blankInputs.map((clientSecret) => ({
        clientId, clientSecret, expectedId: defaultClientId,
        expectedSecretIdentity: defaultSecretIdentity, succeeds: true,
      })),
    ),
    {
      clientId: defaultClientId, clientSecret: undefined, expectedId: defaultClientId,
      expectedSecretIdentity: defaultSecretIdentity, succeeds: true,
    },
    {
      clientId: " custom-id ", clientSecret: " custom-secret ", expectedId: "custom-id",
      expectedSecretIdentity: identity("custom-secret"), succeeds: true,
    },
    ...blankInputs.map((clientSecret) => ({
      clientId: "custom-id", clientSecret, expectedId: "custom-id",
      expectedSecretIdentity: identity(undefined), succeeds: false,
    })),
    {
      clientId: defaultClientId, clientSecret: " override ", expectedId: defaultClientId,
      expectedSecretIdentity: identity("override"), succeeds: false,
    },
    {
      clientId: undefined, clientSecret: " override ", expectedId: defaultClientId,
      expectedSecretIdentity: identity("override"), succeeds: false,
    },
  ];

  it.each(cases)("selects and exchanges credential case %#", async ({
    clientId, clientSecret, expectedId, expectedSecretIdentity, succeeds,
  }) => {
    const flow = await beginAuthorizationCode({
      clientId, clientSecret, redirectUri: "http://127.0.0.1:33333/callback",
    });
    expect(new URL(flow.verificationUri).searchParams.get("client_id")).toBe(expectedId);
    expect(identity(flow.clientSecret)).toBe(expectedSecretIdentity);
    expect(flow.clientSecret ? flow.verificationUri.includes(flow.clientSecret) : false).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        const body = init?.body as URLSearchParams;
        expect(body.get("client_id")).toBe(expectedId);
        expect(identity(body.get("client_secret"))).toBe(expectedSecretIdentity);
        const requiredIdentity = expectedId === defaultClientId
          ? defaultSecretIdentity : identity("custom-secret");
        if (identity(body.get("client_secret")) !== requiredIdentity) {
          return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
        }
        return new Response(JSON.stringify({
          access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600,
        }));
      }
      if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return new Response(JSON.stringify({ emailAddress: "user@gmail.com" }));
      }
      throw new Error("Unexpected OAuth request");
    }));
    const completion = completeAuthorizationCode(flow, {
      authorizationResponse: `${flow.redirectUri}?code=auth-code&state=${flow.state}`,
    });
    if (!succeeds) {
      await expect(completion).rejects.toThrow("invalid_client");
      return;
    }
    const result = await completion;
    expect(result.tokens.clientId).toBe(expectedId);
    expect(identity(result.tokens.clientSecret)).toBe(expectedSecretIdentity);
    expect(result.tokens.refreshToken).toBe("refresh-token");
    expect(result.email).toBe("user@gmail.com");
  });

  it("builds a Gmail OAuth URL with PKCE, state, and a configured redirect URI", async () => {
    const flow = await beginAuthorizationCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://mail.example.com/oauth/gmail/callback",
      loginHint: "user@example.com",
    });
    const url = new URL(flow.verificationUri);

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("user@example.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("redirect_uri")).toBe("https://mail.example.com/oauth/gmail/callback");
    expect(flow.redirectUri).toBe("https://mail.example.com/oauth/gmail/callback");
    expect(flow.userCode).toBe("");
    expect(flow.consumeAuthorizationResponse()).toBeUndefined();
  });

  it("starts a loopback callback server when redirectUri is not configured", async () => {
    const flow = await beginAuthorizationCode({ clientId: "client-id" });
    const url = new URL(flow.verificationUri);
    const redirectUri = url.searchParams.get("redirect_uri");

    expect(redirectUri).toBe(flow.redirectUri);
    expect(redirectUri).toBe("http://127.0.0.1:33333/callback");

    const callback = `${flow.redirectUri}?code=auth-code&state=${flow.state}`;
    const res = await fetch(callback);
    expect(res.status).toBe(200);

    const captured = flow.consumeAuthorizationResponse();
    expect(captured?.authorizationResponse).toBeTruthy();
    const capturedUrl = new URL(captured?.authorizationResponse ?? "");
    expect(capturedUrl.searchParams.get("code")).toBe("auth-code");
    expect(capturedUrl.searchParams.get("state")).toBe(flow.state);
    expect(flow.consumeAuthorizationResponse()).toBeUndefined();

    flow.cancel();
  });

  it("exchanges a pasted redirect URL for tokens after validating state", async () => {
    const flow = await beginAuthorizationCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://127.0.0.1/oauth2callback",
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("client_id")).toBe("client-id");
        expect(body.get("client_secret")).toBe("client-secret");
        expect(body.get("code")).toBe("auth-code");
        expect(body.get("redirect_uri")).toBe(flow.redirectUri);
        expect(body.get("code_verifier")).toBe(flow.codeVerifier);
        return new Response(JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.modify",
        }), { status: 200 });
      }
      if (href === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
        return new Response(JSON.stringify({ emailAddress: "User@Gmail.com" }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const redirectUrl = `${flow.redirectUri}?code=auth-code&state=${flow.state}`;
    const result = await completeAuthorizationCode(flow, { authorizationResponse: redirectUrl });

    expect(result.email).toBe("User@Gmail.com");
    expect(result.tokens.clientId).toBe("client-id");
    expect(result.tokens.clientSecret).toBe("client-secret");
    expect(result.tokens.accessToken).toBe("access-token");
    expect(result.tokens.refreshToken).toBe("refresh-token");
    expect(result.tokens.scopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
  });

  it("rejects pasted redirect URLs with a mismatched state", async () => {
    const flow = await beginAuthorizationCode({
      clientId: "client-id",
      redirectUri: "http://127.0.0.1/oauth2callback",
    });

    await expect(
      completeAuthorizationCode(flow, {
        authorizationResponse: `${flow.redirectUri}?code=auth-code&state=wrong-state`,
      }),
    ).rejects.toThrow("OAuth state mismatch");
  });
});
