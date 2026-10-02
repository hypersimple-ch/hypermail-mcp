import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { OAuth2Client } from "google-auth-library";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_OAUTH2_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
];

export const DEFAULT_GMAIL_OAUTH_CALLBACK_PATH = "/oauth/gmail/callback";

const DEFAULT_FLOW_TTL_MS = 20 * 60_000;

export interface AuthorizationCodeBeginOptions {
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  loginHint?: string;
}

export interface AuthorizationCodeBegin {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresAt: string; // ISO
  state: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  clientId: string;
  clientSecret?: string;
  cancel(): void;
  consumeAuthorizationResponse(): AuthorizationCodeCompletionInput | undefined;
}

export interface AuthorizationCodeCompletionInput {
  /** Full redirected URL copied from the browser after Google consent. */
  authorizationResponse?: string;
  /** Raw authorization code, for clients that extract it themselves. */
  code?: string;
  /** OAuth state returned alongside the raw authorization code. */
  state?: string;
}

export interface SerializedGmailTokens {
  /** Client ID used to authenticate this account. */
  clientId: string;
  /** Client secret, if any. */
  clientSecret?: string;
  /** Current access token. */
  accessToken: string;
  /** Long-lived refresh token. */
  refreshToken: string;
  /** Expiry timestamp in milliseconds since epoch. */
  expiryDate: number;
  /** Scopes granted. */
  scopes: string[];
  /** Email address associated with this account. */
  email: string;
}

/** Type guard — validates that an unknown value has the shape of SerializedGmailTokens. */
export function isSerializedGmailTokens(
  obj: unknown,
): obj is SerializedGmailTokens {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.clientId === "string" &&
    (o.clientSecret === undefined || typeof o.clientSecret === "string") &&
    typeof o.accessToken === "string" &&
    typeof o.refreshToken === "string" &&
    typeof o.expiryDate === "number" &&
    Array.isArray(o.scopes) &&
    typeof o.email === "string"
  );
}

/**
 * Build an {@link OAuth2Client} hydrated with stored tokens.
 * Returns a fresh client that can be used for silent refresh.
 */
export function buildOAuth2Client(
  tokens?: SerializedGmailTokens,
): OAuth2Client {
  const client = new OAuth2Client({
    clientId: tokens?.clientId,
    clientSecret: tokens?.clientSecret,
  });
  if (tokens) {
    client.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiryDate,
      scope: tokens.scopes.join(" "),
    });
  }
  return client;
}

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function randomBase64Url(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

function codeChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function htmlResponse(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><p>${body}</p></body>
</html>`;
}

function sendHtml(res: ServerResponse, status: number, title: string, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(htmlResponse(title, body));
}

interface LocalCallback {
  redirectUri: string;
  cancel(): void;
  consumeAuthorizationResponse(): AuthorizationCodeCompletionInput | undefined;
}

async function startLocalCallbackServer(): Promise<LocalCallback> {
  let redirectUri = "";
  let captured: string | undefined;
  let closed = false;

  const server = createHttpServer((req, res) => {
    if (!req.url) {
      sendHtml(res, 400, "Gmail authorization failed", "The callback URL was empty.");
      return;
    }

    const callbackUrl = new URL(req.url, redirectUri);
    if (callbackUrl.pathname !== "/callback") {
      sendHtml(res, 404, "Not found", "This local callback server only handles Gmail OAuth redirects.");
      return;
    }

    captured = callbackUrl.toString();
    const error = callbackUrl.searchParams.get("error");
    if (error) {
      sendHtml(res, 400, "Gmail authorization failed", "You can close this tab and return to your MCP client.");
    } else {
      sendHtml(res, 200, "Gmail authorization complete", "You can close this tab and return to your MCP client.");
    }
    setImmediate(closeServer);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(33333, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    closeServer();
    throw new Error("Failed to start local Gmail OAuth callback server");
  }
  redirectUri = "http://127.0.0.1:33333/callback";

  function closeServer(): void {
    if (closed) return;
    closed = true;
    try {
      server.close();
    } catch {
      // Server may already be closed; ignore.
    }
  }

  return {
    redirectUri,
    cancel: closeServer,
    consumeAuthorizationResponse() {
      if (!captured) return undefined;
      const authorizationResponse = captured;
      captured = undefined;
      return { authorizationResponse };
    },
  };
}

/** Fetch the email address associated with an access token via the Gmail profile endpoint. */
async function getEmailFromToken(accessToken: string): Promise<string> {
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to get Gmail profile (${res.status}): ${body}`,
    );
  }
  const data = (await res.json()) as { emailAddress: string };
  return data.emailAddress;
}

/**
 * Start a Google OAuth 2.0 authorization-code flow for Gmail.
 *
 * Google rejects Gmail API scopes on the device-code endpoint, so Gmail uses a
 * browser URL. When `redirectUri` is configured, the HTTP server can receive the
 * callback. Otherwise, local/stdio runs start a temporary loopback listener and
 * the agent can poll `complete_add_account` until the browser redirect arrives.
 */
export async function beginAuthorizationCode(
  options: AuthorizationCodeBeginOptions = {},
): Promise<AuthorizationCodeBegin> {
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const clientId = options.clientId;
  if (!clientId) {
    throw new Error(
      "HYPERMAIL_GMAIL_CLIENT_ID is required for Gmail OAuth — set HYPERMAIL_GMAIL_CLIENT_ID before adding a Gmail account",
    );
  }

  const localCallback = options.redirectUri ? undefined : await startLocalCallbackServer();
  const redirectUri = options.redirectUri ?? localCallback?.redirectUri;
  if (!redirectUri) {
    throw new Error("Failed to resolve Gmail OAuth redirect URI");
  }

  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(64);
  const expiresAt = new Date(Date.now() + DEFAULT_FLOW_TTL_MS).toISOString();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: codeChallenge(codeVerifier),
    code_challenge_method: "S256",
  });
  if (options.loginHint) params.set("login_hint", options.loginHint);

  const verificationUri = `${GOOGLE_AUTH_URL}?${params.toString()}`;
  return {
    userCode: "",
    verificationUri,
    message:
      "Open this URL in a browser to authorize Gmail access. After approval, " +
      "the account setup should complete automatically when the agent polls. " +
      "If the browser cannot reach the callback, paste the final redirected URL back to the agent.",
    expiresAt,
    state,
    codeVerifier,
    redirectUri,
    scopes,
    clientId,
    clientSecret: options.clientSecret || undefined,
    cancel() {
      localCallback?.cancel();
    },
    consumeAuthorizationResponse() {
      return localCallback?.consumeAuthorizationResponse();
    },
  };
}

function parseAuthorizationCompletion(
  flow: AuthorizationCodeBegin,
  input: AuthorizationCodeCompletionInput,
): { code: string; state?: string } {
  if (input.authorizationResponse) {
    let url: URL;
    try {
      url = new URL(input.authorizationResponse);
    } catch {
      throw new Error("authorizationResponse must be a full redirected URL");
    }
    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description");
      throw new Error(
        `Google OAuth failed: ${description || error}`,
      );
    }
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error("authorizationResponse is missing the OAuth code");
    }
    return { code, state: url.searchParams.get("state") ?? undefined };
  }

  if (input.code) {
    return { code: input.code, state: input.state };
  }

  throw new Error(
    "Paste the final redirected URL from Google as authorizationResponse, or provide code and state",
  );
}

export async function completeAuthorizationCode(
  flow: AuthorizationCodeBegin,
  input: AuthorizationCodeCompletionInput,
): Promise<{ tokens: SerializedGmailTokens; email: string }> {
  const { code, state } = parseAuthorizationCompletion(flow, input);
  if (state !== undefined && state !== flow.state) {
    throw new Error("OAuth state mismatch — restart Gmail account setup");
  }

  const tokenParams = new URLSearchParams();
  tokenParams.set("client_id", flow.clientId);
  if (flow.clientSecret) tokenParams.set("client_secret", flow.clientSecret);
  tokenParams.set("code", code);
  tokenParams.set("redirect_uri", flow.redirectUri);
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code_verifier", flow.codeVerifier);

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams,
  });

  const tokenData = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      "Token request failed: " +
        (tokenData.error_description ?? tokenData.error ?? tokenRes.statusText),
    );
  }

  const email = await getEmailFromToken(tokenData.access_token);
  const tokens: SerializedGmailTokens = {
    clientId: flow.clientId,
    clientSecret: flow.clientSecret,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? "",
    expiryDate: tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : Date.now() + 3600_000,
    scopes: tokenData.scope ? tokenData.scope.split(" ") : flow.scopes,
    email,
  };
  return { tokens, email };
}

/**
 * Acquire a fresh access token for a stored account, refreshing silently from
 * the persisted refresh token. Returns the (possibly-updated) tokens so the
 * caller can write them back to the store.
 */
export async function acquireAccessToken(
  tokens: SerializedGmailTokens,
  scopes: string[] = DEFAULT_SCOPES,
): Promise<{ accessToken: string; tokens: SerializedGmailTokens }> {
  const client = buildOAuth2Client(tokens);
  const res = await client.getAccessToken();
  if (!res.token) {
    throw new Error(
      "Failed to acquire access token — refresh token may be revoked; re-run add_account",
    );
  }

  const creds = client.credentials;
  const next: SerializedGmailTokens = {
    ...tokens,
    accessToken: res.token,
    refreshToken: creds.refresh_token ?? tokens.refreshToken,
    expiryDate: creds.expiry_date ?? Date.now() + 3600_000,
    scopes,
  };
  return { accessToken: res.token, tokens: next };
}

/**
 * Revoke a refresh token so the stored account is fully de-authorized.
 * Best-effort — failures are swallowed since we'll delete the stored tokens
 * regardless.
 */
export async function revokeRefreshToken(
  tokens: SerializedGmailTokens,
): Promise<void> {
  try {
    await fetch(GOOGLE_OAUTH2_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refreshToken }).toString(),
    });
  } catch {
    /* best-effort */
  }
}
