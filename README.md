# hypermail-mcp

A **Model Context Protocol** server that lets an agent operate any of the user's
inboxes through a single, unified tool surface.

## Unreleased correctness fixes

- Composition is Markdown-only: `send_email`, `draft_email`, and replacement content in `edit_draft` reject raw HTML before provider mutations. `draft_email` and `edit_draft` return authoritative `draftMarkdown`, replacing `draftHtml`. `read_email` supports only `markdown` (default) and explicit `html`; plain-text-only messages retain their literal body.
- Draft selections are exact, unique Markdown words, phrases or complete blocks copied from `draftMarkdown` or a complete current `read_email`. Re-read truncated previews first. Source-position edits preserve unselected HTML bytes, signatures and thread history. Unsafe syntax/structure selections are rejected before attachment changes. Inline replacements require inline Markdown without a signature; select a complete block for multiple paragraphs.
- Persistence checks compare the complete HTML tree, not replacement substrings or Markdown equality. Outlook envelopes, encoding declarations, CRLF and safe block-separator whitespace are tolerated; missing history or changes to inline whitespace, styles, links, images and comments remain failures.
- Verification: 367 full-suite tests passed, plus typecheck and build. Local-build MCP stdio smoke passed on Outlook (`mateo.tiedra@outlook.com`) and Gmail (`mateo.tiedra@hypersimple.ch`): draft creation, multi-paragraph replacement, word replacement, provider readback, witness preservation, raw-HTML rejection without mutation and `text` format rejection. Test drafts were retained; no emails were sent. Visual rendering was not reviewed.

- Attachment downloads use distinct private temporary directories and files; email-controlled filenames cannot overwrite files or escape the download directory. Consumers may remove their downloaded file's directory when finished.
- Provider-read timeouts cannot claim new emails or initialize polling checkpoints after the caller has timed out. Successful reads commit under the existing store lock; this is not network-level exactly-once delivery. Gmail polling follows remaining API pages.
- Gmail draft references remain message IDs; draft-container lookup is internal. Draft edits and attachment mutations preserve parsed MIME content and return current provider IDs. Bulk removal validates original attachment IDs before rewriting; IMAP replacements are readable before the old draft is deleted. A post-replacement deletion failure reports both IDs.
- Replies preserve RFC threading and decoded quoted history; reply-all excludes inherited self/Bcc addresses. Forwards retain decoded content and attachments. Gmail API MIME retains Bcc recipients; IMAP SMTP uses an explicit To/Cc/Bcc envelope without a wire Bcc header.
- Settings are patched against the latest locked account state, preserving refreshed tokens and checkpoints. `style: null` clears style; omitted settings remain unchanged. Closed IMAP connections reconnect on the next operation without replaying failed writes.
- HTTP accepts only `/mcp` (query strings allowed), caps POST bodies at 16 MiB, and reports malformed JSON, missing sessions and expired sessions with recoverable protocol errors. HTTP is for local/private use or an authenticated reverse proxy, **not public unauthenticated exposure**; see [hosting](docs/hosting.md). Tool allow/deny lists and encryption-at-rest are not authentication.

Verification: 326 tests passed, TypeScript checks and the Node 20-targeted build passed, and isolated actual-MCP HTTP and MIME/SMTP serialization smoke checks passed. Live no-send draft checks passed on Outlook for combined body edits, bulk attachment removal/addition, downloads, and move/trash. Gmail draft edits, Bcc preservation, additions, reply/forward content, downloads, and move/trash were exercised. No email was sent; test drafts were trashed and local fixtures removed.

Known live gaps: Gmail attachment tokens change between reads of an unchanged draft, causing bulk removal to reject a previously returned ID and download metadata lookup to fall back to `attachment`. Gmail readback also omits a text attachment when it is mistaken for a body and misparses quoted recipient names containing commas. These defects remain unresolved. Live IMAP checks were blocked by account authentication; live SMTP sending was not attempted.

> **v0.7.27** — Outlook message links are now normalized to canonical web URLs,
> preventing malformed or inconsistently encoded links in email results.
>
> **v0.7.26** — Email results now include a provider-native `webUrl` when
> available, or a per-message `webUrlUnavailableReason`. Links are returned by
> browse, new-email, attachment, compose, draft, and organization tools. Outlook
> refreshes post-move IDs and links with an OWA fallback, Gmail returns
> account-aware links, and generic IMAP reports that web links are unsupported.
>
> **v0.7.25** — Gmail reauthorization now replaces any cached client after
> persisting fresh OAuth credentials, so subsequent operations do not reuse
> stale credentials and fail with `invalid_grant`.
>
> **v0.7.24** — `search_emails` now accepts provider-neutral `from`, `to`, and
> `cc` filters in addition to optional free text. Criteria combine with AND,
> while `cc` searches both CC and BCC recipients consistently across Outlook,
> Gmail, and IMAP.
>
> **v0.7.23** — IMAP reply drafts now retain the referenced message as quoted
> history and canonicalize generated MIME line endings before IMAP APPEND, so
> servers that reject bare newlines can save reply drafts successfully.
>
> **v0.7.22** — Fixed IMAP `edit_draft` updates so body-only edits preserve
> the draft's existing recipients, subject, reply context, and attachments.
>
> **v0.7.21** — `send_email` and `draft_email` now treat the exact string
> `"false"` for `inReplyTo` as the boolean `false`, so agents that serialize
> that explicit new-message marker as text can forward with `forwardMessageId`
> instead of incorrectly triggering the reply/forward exclusivity check.
>
> **v0.7.20** — Hardened long-running IMAP and new-email polling paths:
> IMAP connections now use explicit connection/greeting/socket/operation
> timeouts, reset stuck connections, and report post-TLS authentication
> failures with account-specific remediation guidance. `get_new_emails` now
> applies per-account timeouts during candidate collection and hydration so one
> hanging account does not block all-account polling; partial timeout failures
> are returned alongside successful accounts' emails.
>
> **v0.7.19** — Hardened Outlook ID handling when Microsoft Graph `$search`
> returns IDs that `/me/messages/{id}` rejects as malformed: `search_emails`
> now returns a translated readable immutable ID when available, and
> `read_email` retries malformed/stale IDs through `translateExchangeIds`
> before failing. `list_emails` also falls back from localized folder display
> names such as `Éléments envoyés` to the matching Graph folder ID.
>
> **v0.7.18** — `search_emails` can now omit `account` to search all
> registered accounts in parallel, returning account-annotated results plus
> per-account errors without discarding successful matches. All-account
> `get_new_emails` polling also collects and hydrates per-account batches in
> parallel while preserving the global oldest-first limit.
>
> **v0.7.17** — Hardened Outlook message IDs returned by `list_emails` and
> `search_emails`: Outlook reads now request Microsoft Graph immutable IDs,
> `search_emails` probes results and marks stale/not-found messages with
> `stale: true`, and `read_email` / `read_attachment` keep a legacy mutable-ID
> fallback for older IDs. Graph errors now include structured diagnostic details
> when available.
>
> **v0.7.16** — Hardened `draft_email` after successful draft creation:
> if post-save readback fails, the tool now returns the created draft ID with
> `warning` and `draftReadbackError` instead of losing the draft behind an
> error. Compose operations also emit sanitized `HYPERMAIL_DEBUG` stage logs,
> IMAP drafts now use the server-advertised `\\Drafts` mailbox when present,
> and the CLI supports `--version`.
>
> **v0.7.15** — Hardened IMAP draft creation: drafts now append directly to
> the Drafts mailbox, retry without the `\\Draft` flag when an IMAP server
> rejects flagged APPEND, and preserve IMAP reply/forward context in drafts the
> same way `send_email` does. IMAP operations for a single account are serialized
> to avoid shared-connection races, and IMAP write failures now include safe
> server response details instead of only `Command failed`. Account setup
> responses no longer expose stored provider tokens/passwords. Also rejects
> multiline plain text passed as `format: "html"`, and adds the Hermes
> `get_new_emails` poller example.
>
> **v0.7.14** — Added opt-in `HYPERMAIL_DEBUG` structured stderr logs with
> redaction for server startup, account-store locking/checkpoint writes, and
> `get_new_emails` candidate/claim flow. Hardened Outlook `edit_draft` body
> updates by requesting Graph's updated representation, re-reading with retries,
> and returning an error instead of `edited: true` if the requested body change
> is not observable; Outlook body edits also get one safe replay after attachment
> handling when the final read is stale.
>
> **v0.7.13** — Hardened `get_new_emails` against duplicate delivery when
> multiple MCP processes share the same encrypted account store. Store writes
> now reload and merge under a cross-process lock, checkpoints are monotonic,
> and new-email batches are atomically claimed before being returned. `trash_email`
> also now uses provider-native trash operations for Gmail and IMAP trash aliases.
>
> **v0.7.12** — Hardened Outlook reply/forward draft formatting when
> Microsoft Graph labels generated thread history as HTML but returns
> plain/unstructured text. Such histories are now defensively normalized with
> escaped content and line breaks so quoted messages remain readable.
>
> **v0.7.11** — Fixed Outlook reply/forward drafts whose Graph-generated
> quoted bodies are plain text by escaping them and patching the draft as HTML,
> so newly composed HTML replies no longer render as raw text.
>
> **v0.7.10** — Fixed an account-store race where Gmail/Outlook token
> refreshes could overwrite `get_new_emails` checkpoints. Checkpoint updates now
> preserve token data and merge delivered IDs at the same timestamp. `edit_draft`
> body edits now require exact selected-section replacement (`old_text` +
> `new_text`) so reply/forward history is preserved instead of overwritten.
>
> **v0.7.9** — Replaced server-side email watch/webhook/script delivery with
> the pull-based `get_new_emails` tool. Agents schedule their own repeated calls
> and fetch bounded batches of new inbox email.
>
> **v0.7.8** — Default Gmail loopback redirect URI changed from random-port
> `/oauth2callback` to fixed `http://127.0.0.1:33333/callback` (still overridable via
> `HYPERMAIL_GMAIL_REDIRECT_URI`). `.data/` encryption key directory added to
> `.gitignore`.
>
> **v0.7.7** — Env-only configuration. Runtime config now comes from flat
> `HYPERMAIL_*` environment variables plus selected CLI overrides. Config files
> and legacy provider env names are no longer read. Hosted Gmail OAuth callbacks
> are supported via `HYPERMAIL_GMAIL_REDIRECT_URI`; local loopback and manual
> completion still work.
>
> **v0.7.6** — Gmail setup uses OAuth authorization URLs instead of Google's
> rejected device-code flow for Gmail API scopes. `complete_add_account` accepts
> a final redirected URL or raw `code`/`state`, and provider credentials use
> dedicated `HYPERMAIL_GMAIL_*` / `HYPERMAIL_OUTLOOK_*` env vars.
>
> **v0.7.5** — Attachments via file path on `send_email`/`draft_email`
> (`attachments` param). `edit_draft` gains `new_attachments` and
> `remove_attachments` — `add_attachment_to_draft` is removed (23 tools now).
> Draft editing uses multi-strategy thread boundary detection for more reliable
> quoted-thread preservation. Published CLI installs the MCP SDK dependency so
> global/npx runs do not fail on a missing SDK module.
>
> **v0.7.4** — `inReplyTo` is now a required parameter on `send_email` and
> `draft_email` (was optional). Set it to `false` for a new email, or pass a
> message ID to thread a reply. This forces the agent to make an explicit choice
> instead of silently treating replies as new conversations.
>
> **v0.7.3** — `edit_draft` now preserves the quoted thread history when editing
> Outlook reply/forward drafts. Previously, editing a draft body would overwrite
> the entire content — including the quoted thread. Now only the answer part
> (above the spacer delimiter) is replaced.
>
> **v0.7.1** — Every config field is now settable via a dedicated
> `HYPERMAIL_*` env var. Legacy provider env vars are no longer accepted. See
> [Environment Variables](#environment-variables) for the full reference.

> **v0.6.3** — Unify stdio and HTTP modes into a single feature set. Removed
> email watch (inbox polling, SSE push, notification buffer), agent
> multi-tenancy (`agents.yaml`, `x-api-key` auth, per-agent allowlists), and
> the `check_notifications` tool. Dropped `js-yaml` dependency. Dockerfile
> simplified to a single `install → build → prune` step.
>
> **v0.6.2** — Version source-of-truth fix: `version.ts` now imports directly
> from `package.json` instead of hardcoding, preventing version drift between
> the two files.
>
> **v0.6.1** — Docker deployment (standalone Dockerfile with HEALTHCHECK),
> email notification bug fixes (ID-based dedup, pagination cap, dynamic
> re-scan), Node 22 base image, dropped docker-compose.
>
> **v0.5.0** — Replaced optional `isHtml` boolean with required `format`
> parameter (`"html"` | `"markdown"`) on `send_email`, `draft_email`, and
> `edit_draft`. Markdown bodies are converted to HTML via `marked` so
> recipients always see clean HTML.
>
> **v0.4.3** — Upgraded Zod to v4.4.3. Fixed MCP SDK v1.29.0 compatibility
> by wrapping all tool schemas in `z.object()` and replacing discriminated
> union output schemas that caused `validateToolOutput` crashes.

The agent doesn't care whether an address is a work Outlook account, a personal
Microsoft account, a personal IMAP mailbox, or Gmail — it just calls
`list_emails`, `search_emails`, `read_email`, `send_email` and passes the email
address as the `account` argument. The server routes to the right backend.

**v1 status:** Outlook / Microsoft 365 (personal + work) fully supported via
Microsoft Graph. IMAP (any IMAP server) supported via `imapflow` + `nodemailer`.
Gmail supported via Google OAuth authorization-code flow with local loopback or
hosted callbacks plus remote-safe manual completion.

## Why

- Existing Outlook/M365 MCP servers (e.g. `@softeria/ms-365-mcp-server`) expose
  ~200 raw Graph endpoints and are tied to a single signed-in user.
- This project wraps the same proven stack (`@azure/msal-node` for auth,
  `@microsoft/microsoft-graph-client` for HTTP) but exposes only a small,
  provider-agnostic email API and supports **multiple accounts at once**, keyed
  by email address.

## Install / run

```bash
npm install -g hypermail-mcp     # or pnpm / npx
hypermail-mcp --help
```

Run as a stdio MCP server (the default) — wire it into your MCP host:

### Claude Desktop / Claude Code

```jsonc
{
  "mcpServers": {
    "hyper-email": {
      "command": "npx",
      "args": ["-y", "hypermail-mcp"]
    }
  }
}
```

Or via the CLI:

```bash
claude mcp add hypermail -- npx -y hypermail-mcp
```

### As a hosted HTTP server

```bash
hypermail-mcp --http --port 3000 --host 0.0.0.0
# endpoint: http://<host>:3000/mcp  (Streamable HTTP transport, session-aware)
```

When hosted, set `HYPERMAIL_KEY` so the account file is reproducibly
decryptable across restarts and redeploys.

### Docker

```bash
# Build
docker build -t hypermail-mcp .

# Run
# Pass secret values from your shell or deployment environment; do not commit them.
docker run -d \
  --name hypermail-mcp \
  -p 3000:3000 \
  -e HYPERMAIL_KEY \
  -e HYPERMAIL_OUTLOOK_CLIENT_ID \
  -e HYPERMAIL_OUTLOOK_TENANT_ID \
  -v hypermail-data:/var/lib/mcp \
  hypermail-mcp
```

The image runs the server in HTTP mode on port 3000 with a 30-second
HEALTHCHECK against `/mcp`. Data is persisted via a Docker volume at
`/var/lib/mcp`.

### Development

To test the HTTP server locally:

```bash
# Terminal 1: auto-rebuild TypeScript on save
pnpm dev

# Terminal 2: start HTTP server with env/CLI config
pnpm dev:http
```

The server listens on `http://127.0.0.1:3000/mcp`.

## Runtime and provider configuration

Hypermail uses flat `HYPERMAIL_*` environment variables as the source of truth.
There is no runtime config file. CLI flags only override transport, host, port,
and data directory for a single invocation.

CLI flags: `--http`, `--port`, `--host`, `--data-dir`, `--version`, `--help`.

Subcommands: `hypermail-mcp generate-key` — generate a base64 32-byte key for
`HYPERMAIL_KEY`.

### Local CLI / env example

```bash
export HYPERMAIL_KEY="$(hypermail-mcp generate-key)"
export HYPERMAIL_DATA_DIR="$HOME/.local/share/hypermail-mcp"
export HYPERMAIL_OUTLOOK_CLIENT_ID="<your-client-id>"
hypermail-mcp
```

### Generic MCP client JSON example

```jsonc
{
  "mcpServers": {
    "hypermail": {
      "command": "npx",
      "args": ["-y", "hypermail-mcp"],
      "env": {
        "HYPERMAIL_KEY": "${HYPERMAIL_KEY}",
        "HYPERMAIL_DATA_DIR": "${HYPERMAIL_DATA_DIR}",
        "HYPERMAIL_OUTLOOK_CLIENT_ID": "${HYPERMAIL_OUTLOOK_CLIENT_ID}"
      }
    }
  }
}
```

### Environment Variables

| Env var | Purpose | Default / behavior |
| --- | --- | --- |
| `HYPERMAIL_DATA_DIR` | Account/token store location | `${XDG_DATA_HOME:-~/.local/share}/hypermail-mcp` |
| `HYPERMAIL_KEY` | 32-byte AES-256-GCM key as hex/base64, or any passphrase derived via SHA-256 | If unset, generates and persists a local key and prints a startup warning |
| `HYPERMAIL_TRANSPORT` | Runtime transport: `stdio` or `http` | `stdio`; `--http` overrides to `http` |
| `HYPERMAIL_HTTP_PORT` | HTTP bind port | `3000`; invalid HTTP-mode values warn and fall back |
| `HYPERMAIL_HTTP_HOST` | HTTP bind host | `127.0.0.1`; invalid HTTP-mode values warn and fall back |
| `HYPERMAIL_OUTLOOK_CLIENT_ID` | Optional custom Azure/Entra public client ID | Built-in public client |
| `HYPERMAIL_OUTLOOK_TENANT_ID` | Optional Outlook tenant/authority selector | `common` |
| `HYPERMAIL_GMAIL_CLIENT_ID` | Google OAuth client ID | Required when adding a Gmail account |
| `HYPERMAIL_GMAIL_CLIENT_SECRET` | Google OAuth client secret, when issued by the client type | unset |
| `HYPERMAIL_GMAIL_REDIRECT_URI` | Hosted Gmail OAuth callback URI | Local loopback callback when unset |
| `HYPERMAIL_TOOLS_ENABLED` | Comma-separated tool allowlist | Empty/unset means no filtering |
| `HYPERMAIL_TOOLS_DISABLED` | Comma-separated tool blocklist | Empty/unset means no filtering |
| `HYPERMAIL_DEBUG` | Enable structured debug logs to stderr (`1`, `true`, `yes`, `on`, or `debug`) | Disabled by default |

**Priority order:** selected CLI flags > `HYPERMAIL_*` env vars > hardcoded defaults.

Per-tool filtering (`HYPERMAIL_TOOLS_ENABLED` / `HYPERMAIL_TOOLS_DISABLED`) lets
operators ship minimal agent-facing surfaces. If both non-empty lists are set,
or either list contains an unknown tool name, startup fails.

## Tools

All "email" tools take an `account` argument — the email address of the inbox
to operate on. The server resolves the right provider from the encrypted
account store.

Tools that return or modify an identifiable email include a user-shareable
`webUrl` for opening that message in the provider's native web client. The URL
contains no credentials; the person opening it must already have mailbox
access. When a URL cannot be supplied, the same email/result instead includes
`webUrlUnavailableReason` (including on every item in collection responses).
Outlook uses Microsoft Graph's native link and refreshes moved items before
returning their post-operation ID/link. Gmail links are account-aware but use a
best-effort, unofficial web route. Generic IMAP has no universal webmail URL, so
it returns an unsupported reason and never fabricates an `imap://` URL.

| Tool | Inputs | Notes |
| --- | --- | --- |
| `list_accounts` | — | Returns registered emails + provider, no secrets. |
| `add_account` | `provider`, `email?`, `config?` | Starts the provider add flow. Outlook returns a device code; Gmail returns an OAuth URL. Ready account responses include public metadata only and never return stored tokens/passwords. Returns `{handle, verification:{type, userCode, verificationUri, expiresAt, message}}` for pending flows. |
| `complete_add_account` | `provider`, `handle`, `authorizationResponse?`, `code?`, `state?` | Returns `pending` / `ready` / `expired` / `error`. Ready account responses include public metadata only and never return stored tokens/passwords. Gmail accepts a pasted final redirected URL or raw code/state for remote-safe completion. |
| `get_account_settings` | `account` | Get signature (HTML) and style preferences for an account. |
| `set_account_settings` | `account`, `signature?`, `signaturePath?`, `style?` | Set signature HTML (inline or via file path) and font preferences. |
| `remove_account` | `email` | Deletes tokens for the account. |
| `list_emails` | `account`, `folder?`, `limit?`, `unreadOnly?`, `skip?` | Defaults: folder=`inbox`, limit=25. Supports pagination via `skip` — response includes `hasMore`. Outlook accepts well-known folder names, folder IDs, and falls back from localized display names to matching folder IDs. |
| `get_new_emails` | `account?`, `limit?` | Pull new inbox emails not previously returned by this tool. `limit` defaults to 10 and is global when `account` is omitted. Returns full markdown bodies with attachment metadata; bodies may be truncated. |
| `search_emails` | `account?`, `query?`, `from?`, `to?`, `cc?`, `limit?` | Provide at least one of `query`, `from`, `to`, or `cc`; distinct criteria combine with AND. `cc` searches CC or BCC. Search one account when `account` is provided, or omit it to search all registered accounts in parallel. Returns account-annotated summaries and partial per-account errors. Address filters are provider-agnostic; Outlook search results with malformed IDs are normalized to readable immutable IDs when possible. |
| `read_email` | `account`, `id`, `format?` | Returns full body + recipients + attachment metadata. `format`: `markdown` (default) or explicit `html`; `text` is rejected before provider reads. Messages without HTML retain their literal text body. Outlook retries malformed/stale IDs through Graph ID translation before failing. |
| `read_attachment` | `account`, `messageId`, `attachmentId` | Download an attachment to a temporary file and return its path plus the parent message's web link or unavailable reason. |
| `archive_email` | `account`, `id` | Move a message to the Archive folder and return its post-operation ID/link. |
| `trash_email` | `account`, `id` | Move a message to Deleted Items (trash) and return its post-operation ID/link. |
| `move_email` | `account`, `id`, `destination` | Move to any folder by well-known name (`inbox`, `drafts`, etc.) or custom folder ID, returning the post-operation ID/link. |
| `send_email` | `account`, `to[]`, `cc?`, `bcc?`, `subject`, `body`, `include_signature`, `inReplyTo`, `replyAll?`, `forwardMessageId?`, `attachments?` | Send an email. `body` is Markdown only, converted to HTML via `marked`; raw HTML is rejected. Use a blank line between paragraphs. Account styles apply independently of `include_signature`; the saved HTML signature is appended when true. `inReplyTo` sends as threaded reply; `forwardMessageId` sends as forward. `inReplyTo` is required — set to `false` for new emails. `attachments` is an optional array of `{filePath, name?}` — files are read from disk and encoded automatically. |
| `draft_email` | `account`, `to[]`, `cc?`, `bcc?`, `subject`, `body`, `include_signature`, `inReplyTo`, `replyAll?`, `forwardMessageId?`, `attachments?` | Save as draft without sending, with the same Markdown-only params as `send_email`. Returns final draft ID/link and authoritative `draftMarkdown` after readback. Readback failure returns `warning` and `draftReadbackError`. Explicit HTML is available via `read_email(format: "html")`. Replies retain quoted history and threading. Set required `inReplyTo` to `false` for new emails. |
| `edit_draft` | `account`, `id`, `to?`, `cc?`, `bcc?`, `subject?`, `old_text?`, `new_text?`, `body?`, `include_signature?`, `new_attachments?`, `remove_attachments?` | Copy exact, unique `old_text` from complete current `draftMarkdown` or `read_email` Markdown, not HTML or truncated previews. Words, phrases and complete blocks are supported; unsafe structural selections are rejected before any mutation. Provide Markdown-only `new_text`; inline selections cannot accept multiple blocks or signatures. Unselected HTML remains byte-for-byte intact. Empty replacement deletes the selection. `body` remains an alias for `new_text` with `old_text`, never full replacement alone. Complete-body persistence is checked after saving. Returns final draft ID/link, `draftMarkdown` and attachment metadata. `new_attachments` adds `{filePath, name?}[]`; `remove_attachments` removes `string[]` IDs. |
| `send_draft` | `account`, `id` | Send an existing draft email by ID. Use with draft IDs returned by `draft_email` or `edit_draft`. |
| `list_folders` | `account`, `parentFolderId?` | List available mail folders. Returns top-level folders by default, or children of `parentFolderId`. |
| `create_folder` | `account`, `displayName`, `parentFolderId?` | Create a new mail folder under root (default) or the given parent. |
| `delete_folder` | `account`, `folderId` | Delete a mail folder by ID. |
| `rename_folder` | `account`, `folderId`, `newName` | Rename an existing mail folder. |
| `mark_read` | `account`, `id` | Mark a message as read. |
| `mark_unread` | `account`, `id` | Mark a message as unread. |

## Pull new emails

`get_new_emails` is the replacement for server-side watch/push delivery. The
server does not run background cron jobs; agents or their harnesses call this
tool on their own schedule, for example every 30–60 seconds.

**Behavior:**
- Polls **inbox only**.
- `account` is optional. When omitted, the tool checks all registered accounts.
- `limit` defaults to `10`. In all-account mode, the limit is a global total
  across accounts, selected by oldest `receivedAt` first.
- All-account polling performs per-account candidate collection and hydration in
  parallel, then returns the combined batch in oldest-first order.
- First use for an account initializes its checkpoint to the newest inbox email
  and returns no emails for that account.
- Later calls return emails not previously returned by this tool, oldest first.
- Returned bodies are markdown and may be truncated around 20k characters; call
  `read_email` for the full body when needed.
- Attachments are returned as metadata only; call `read_attachment` for content.
- The tool does not mark emails as read.
- `limit: 0` can initialize/check state without fetching message bodies.

All-account calls return partial failures as `errors: [{ account, message }]`
and still return successful accounts' emails. Pollers should continue processing
returned emails when `errors` is non-empty, and use those entries to notify or
log which accounts are failing.

See [`examples/hermes/`](examples/hermes/) for a Hermes scheduler integration
that polls this tool and hands new-email payloads to a Hermes agent.

## Add-account flows

### Outlook

1. Agent calls `add_account({ provider: "outlook" })`.
2. Server returns:
   ```json
   {
     "status": "pending",
     "handle": "…uuid…",
     "verification": {
       "type": "device_code",
       "userCode": "ABCD-EFGH",
       "verificationUri": "https://microsoft.com/devicelogin",
       "expiresAt": "2025-…",
       "message": "To sign in, use a web browser to open …"
     }
   }
   ```
3. The user opens the URL and enters the code.
4. Agent polls `complete_add_account({ provider: "outlook", handle })` until
   it returns `{ "status": "ready", "account": {...} }`.
5. From then on, any tool can be called with `account: "<that-email>"`.

### IMAP

IMAP accounts are added synchronously with host/user/password settings. If the
server accepts TCP/TLS but closes during login, Hypermail reports an IMAP
authentication failure. Check the mailbox password or app-password, confirm IMAP
access is enabled by the provider, then re-add or update the account.

### Gmail

Gmail uses Google OAuth 2.0, matching the official Gmail MCP model. Google's
device-code endpoint rejects Gmail API scopes, so Hypermail uses an authorization
URL with a real callback. Service accounts are only suitable for Google
Workspace domain-wide delegation; they don't grant server-to-server access to
consumer `@gmail.com` inboxes.

For local stdio/Desktop OAuth clients, Hypermail starts a temporary
`127.0.0.1` loopback callback server automatically. For hosted HTTP deployments,
set `HYPERMAIL_GMAIL_REDIRECT_URI` and register the exact URI in Google Auth
Platform, for example:

```bash
HYPERMAIL_TRANSPORT=http
HYPERMAIL_GMAIL_REDIRECT_URI=https://mail.example.com/oauth/gmail/callback
```

1. Configure `HYPERMAIL_GMAIL_CLIENT_ID` and, when issued by your Google client
   type, `HYPERMAIL_GMAIL_CLIENT_SECRET`. Use a Desktop client for local
   loopback, or a Web client for hosted HTTP callbacks.
2. Agent calls `add_account({ provider: "gmail" })`.
3. Server returns an OAuth URL:
   ```json
   {
     "status": "pending",
     "handle": "…uuid…",
     "verification": {
       "type": "oauth_url",
       "userCode": "",
       "verificationUri": "https://accounts.google.com/o/oauth2/v2/auth?...",
       "expiresAt": "2025-…",
       "message": "Open this URL in a browser to authorize Gmail access..."
     }
   }
   ```
4. The user opens `verificationUri` and grants access. If the configured
   callback is reachable, the browser shows a small success page and the agent
   can poll `complete_add_account({ provider: "gmail", handle })` until ready.
5. If the browser cannot reach the callback, the manual fallback still works:
   copy the final redirected URL from the browser address bar and call:
   ```json
   {
     "provider": "gmail",
     "handle": "…uuid…",
     "authorizationResponse": "http://127.0.0.1:54321/oauth2callback?code=...&state=..."
   }
   ```
6. `complete_add_account` validates state, exchanges the code for tokens, stores
   the account, and returns `{ "status": "ready", "account": {...} }`.

## Roadmap

- Threading / conversations.
- Calendar integration.

## Project layout

```
src/
  cli.ts                       # arg parsing + entry
  server.ts                    # MCP server, stdio + HTTP transports, session management
  version.ts                   # version constant
  config.ts                    # env-only config types + resolution
  store/
    account-store.ts           # encrypted multi-account store (AES-256-GCM)
    crypto.ts                  # AES-256-GCM encrypt/decrypt, key resolution, atomic writes
  providers/
    types.ts                   # EmailProvider interface + shared DTOs
    registry.ts                # routes account email → provider
    outlook/
      auth.ts                  # msal-node device-code flow
      client.ts                # @microsoft/microsoft-graph-client factory
      index.ts                 # OutlookProvider implementation
    imap/index.ts              # IMAP provider (imapflow + nodemailer)
    gmail/
      auth.ts                  # Google OAuth authorization-code flow
      client.ts                # Gmail API (googleapis)
      index.ts                 # GmailProvider implementation
    shared/                    # shared utilities across providers
  tools/
    index.ts                   # MCP tool registrations
    accounts.ts                # list/add/remove/complete-add account tools
    browse.ts                  # list/search/read email tools
    new-emails.ts              # get_new_emails pull/checkpoint tool
    compose.ts                 # send/draft/edit/send-draft tools
    folders.ts                 # list/create/delete/rename folder tools
    organize.ts                # archive/trash/move/mark-read/mark-unread tools
    shared.ts                  # shared tool helpers
```

## License

MIT
