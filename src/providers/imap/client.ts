import { ImapFlow } from "imapflow";
import type { Readable } from "node:stream";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import type { AccountRecord } from "../../store/account-store.js";
import type { Logger } from "../../logger.js";
import { noopLogger } from "../../logger.js";

export const IMAP_CONNECTION_TIMEOUT_MS = 15_000;
export const IMAP_GREETING_TIMEOUT_MS = 15_000;
export const IMAP_SOCKET_TIMEOUT_MS = 45_000;
export const IMAP_OPERATION_TIMEOUT_MS = 45_000;

// ---------- token shape ----------

export interface ImapTokens {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

/** Type guard — validates that an unknown value has the shape of ImapTokens. */
export function isImapTokens(obj: unknown): obj is ImapTokens {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.host === "string" &&
    typeof o.port === "number" &&
    typeof o.user === "string" &&
    typeof o.password === "string" &&
    typeof o.smtpHost === "string" &&
    typeof o.smtpPort === "number"
  );
}

/** Extract IMAP tokens from an account record, throwing if malformed. */
export function extractTokens(account: AccountRecord): ImapTokens {
  if (!isImapTokens(account.tokens)) {
    throw new Error(
      "IMAP account tokens are missing or corrupted — re-run add_account",
    );
  }
  return account.tokens as ImapTokens;
}

// ---------- client ----------

/**
 * Per-account IMAP+SMTP client. Wraps an {@link ImapFlow} connection and a
 * {@link Transporter} from nodemailer. The factory caches instances so a
 * single account reuses its connection across calls.
 */
export class ImapClient {
  private imap: ImapFlow | null = null;
  private transporter: Transporter | null = null;
  private connecting: Promise<void> | null = null;
  private imapQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly tokens: ImapTokens,
    private readonly opts: { account?: string; logger?: Logger } = {},
  ) {}

  /** Get (or create) the ImapFlow instance. */
  async getImap(): Promise<ImapFlow> {
    if (this.imap) {
      const connection = this.imap;
      await this.connecting;
      if (this.imap !== connection)
        throw new Error("IMAP connection unavailable after connect");
      return connection;
    }

    const connection = new ImapFlow({
      host: this.tokens.host,
      port: this.tokens.port,
      secure: this.tokens.secure,
      auth: {
        user: this.tokens.user,
        pass: this.tokens.password,
      },
      logger: false,
      connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: IMAP_GREETING_TIMEOUT_MS,
      socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
    });

    this.imap = connection;
    const invalidate = () => {
      if (this.imap === connection) {
        this.imap = null;
        this.connecting = null;
      }
    };
    connection.on("close", invalidate);
    connection.on("error", (err: unknown) => {
      // Never log provider error messages: they can contain credentials or commands.
      this.log("connectionError", {
        authenticationFailed: hasAuthenticationFailedFlag(err),
      });
      invalidate();
    });

    this.log("connectStart");
    const connecting = this.withOperationTimeout("connect", connection.connect())
      .then(() => {
        this.log("connectEnd");
      })
      .catch((err) => {
        const normalized = this.normalizeConnectError(err);
        this.log("connectError", {
          authenticationFailed: hasAuthenticationFailedFlag(err),
        });
        if (this.imap === connection) this.resetImap();
        throw normalized;
      });
    this.connecting = connecting;
    await connecting;
    if (this.imap !== connection)
      throw new Error("IMAP connection unavailable after connect");
    return connection;
  }

  /** Get (or create) a nodemailer SMTP transporter. */
  getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    this.transporter = nodemailer.createTransport({
      host: this.tokens.smtpHost,
      port: this.tokens.smtpPort,
      secure: this.tokens.smtpSecure,
      auth: {
        user: this.tokens.user,
        pass: this.tokens.password,
      },
    });
    return this.transporter;
  }

  /** Run an IMAP operation serially on this account's shared connection. */
  async run<T>(fn: (imap: ImapFlow) => Promise<T>): Promise<T> {
    const run = this.imapQueue.catch(() => undefined).then(async () => {
      const imap = await this.getImap();
      return fn(imap);
    });
    this.imapQueue = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await this.withOperationTimeout("operation", run, () => {
        this.imapQueue = Promise.resolve();
        this.resetImap();
      });
    } catch (err) {
      if (err instanceof ImapTimeoutError) {
        this.log("operationTimeout", { message: err.message });
      }
      throw err;
    }
  }

  /**
   * Acquire a mailbox lock and run `fn` with the mailbox selected.
   * Releases the lock automatically after `fn` completes.
   */
  async withMailbox<T>(mailbox: string, fn: (imap: ImapFlow) => Promise<T>): Promise<T> {
    return this.run(async (imap) => {
      const lock = await imap.getMailboxLock(mailbox);
      try {
        return await fn(imap);
      } finally {
        lock.release();
      }
    });
  }

  /** Disconnect IMAP and close the SMTP pool. */
  async disconnect(): Promise<void> {
    const imap = this.imap;
    this.imap = null;
    this.connecting = null;
    if (imap) {
      try {
        await imap.logout();
      } catch {
        /* ignore */
      }
    }
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }

  private resetImap(): void {
    const imap = this.imap;
    this.imap = null;
    this.connecting = null;
    if (imap) {
      imap.logout().catch(() => {});
    }
  }

  private async withOperationTimeout<T>(
    operation: string,
    promise: Promise<T>,
    onTimeout?: () => void,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new ImapTimeoutError(this.timeoutMessage(operation)));
      }, IMAP_OPERATION_TIMEOUT_MS);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private timeoutMessage(operation: string): string {
    return `IMAP ${operation} timed out after ${IMAP_OPERATION_TIMEOUT_MS}ms for account ${this.accountLabel()} (${this.tokens.host}:${this.tokens.port})`;
  }

  private accountLabel(): string {
    return this.opts.account ?? this.tokens.user;
  }

  private normalizeConnectError(err: unknown): Error {
    if (!isImapAuthenticationError(err)) {
      return err instanceof Error ? err : new Error(String(err));
    }

    const code = imapErrorCode(err);
    const codeSuffix = code ? ` Provider error code: ${code}.` : "";
    return new Error(
      `IMAP authentication failed for account ${this.accountLabel()} ` +
        `(${this.tokens.host}:${this.tokens.port}). ` +
        "Verify the password/app-password and IMAP access policy, then re-add or update the account." +
        codeSuffix,
      { cause: err },
    );
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    (this.opts.logger ?? noopLogger).debug("imap", event, {
      account: this.accountLabel(),
      host: this.tokens.host,
      port: this.tokens.port,
      ...fields,
    });
  }
}

class ImapTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapTimeoutError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isImapAuthenticationError(err: unknown): boolean {
  if (hasAuthenticationFailedFlag(err)) return true;
  const code = imapErrorCode(err);
  if (code === "ClosedAfterConnectTLS") return true;

  const message = errorMessage(err).toLowerCase();
  return (
    message.includes("authentication failed") ||
    message.includes("invalid credentials") ||
    message.includes("login failed")
  );
}

function hasAuthenticationFailedFlag(err: unknown): boolean {
  return readErrorField(err, "authenticationFailed") === true;
}

function imapErrorCode(err: unknown): string | undefined {
  const direct = readErrorField(err, "code");
  if (typeof direct === "string" && direct !== "NoConnection") return direct;

  const nested = readErrorField(readErrorField(err, "error"), "code");
  if (typeof nested === "string") return nested;
  if (typeof direct === "string") return direct;
  return undefined;
}

function readErrorField(err: unknown, field: string): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  return (err as Record<string, unknown>)[field];
}

// ---------- factory ----------

/**
 * Caches {@link ImapClient} instances per account email so connections are
 * reused across calls. Analogous to {@link OutlookClientFactory}.
 */
export class ImapClientFactory {
  private readonly cache = new Map<string, ImapClient>();

  constructor(private readonly logger: Logger = noopLogger) {}

  get(account: AccountRecord): ImapClient {
    const key = account.email.toLowerCase();
    const existing = this.cache.get(key);
    if (existing) return existing;

    const tokens = extractTokens(account);
    const client = new ImapClient(tokens, {
      account: account.email,
      logger: this.logger,
    });
    this.cache.set(key, client);
    return client;
  }

  /** Drop a cached client (e.g. after removeAccount). */
  invalidate(email: string): void {
    const key = email.toLowerCase();
    const existing = this.cache.get(key);
    if (existing) {
      existing.disconnect().catch(() => {});
      this.cache.delete(key);
    }
  }
}
