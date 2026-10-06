# hypermail-mcp

Open-source email MCP server — agents manage Gmail, Outlook, Microsoft 365, and IMAP mailboxes through one unified interface, keyed by email address.

## Purpose

Provides 24 tools to pi for email operations via the Model Context Protocol:
- `list_accounts` / `add_account` / `complete_add_account` / `remove_account` — account management
- `list_emails` / `search_emails` / `read_email` / `read_attachment` — browse and read
- `send_email` / `draft_email` / `edit_draft` / `send_draft` — compose (attachments via `attachments` param on send/draft, and `new_attachments`/`remove_attachments` on edit_draft)
- `archive_email` / `trash_email` / `move_email` / `mark_read` / `mark_unread` — organize
- `list_folders` / `create_folder` / `delete_folder` / `rename_folder` — folders

## Structure

```
src/
├── cli.ts              # Entry point → dist/cli.js (bin: hypermail-mcp)
├── server.ts           # MCP server setup (stdio + HTTP), session management
├── version.ts          # Version constant
├── config.ts           # env-only config types + resolution
├── providers/          # Email provider backends
│   ├── outlook/        # Microsoft Graph API (auth.ts, client.ts, index.ts)
│   ├── imap/           # IMAP provider (index.ts)
│   ├── gmail/          # Gmail API provider (auth.ts, client.ts, index.ts)
│   ├── registry.ts     # Provider registry/selection
│   └── types.ts        # Shared provider interfaces
├── store/              # Persistence
│   ├── account-store.ts  # AES-256-GCM encrypted multi-account store
│   └── crypto.ts         # encrypt/decrypt, key resolution, atomic writes
└── tools/              # Per-tool handler implementations
    ├── index.ts        # Tool registration
    ├── accounts.ts     # Account management tools
    ├── browse.ts       # List/search/read tools
    ├── compose.ts      # Send/draft/attachment tools
    ├── folders.ts      # Folder management tools
    ├── organize.ts     # Archive/trash/move/mark tools
    └── shared.ts       # Shared helpers
```

## Dev Workflow

Configuration is env-only at runtime. Local MCP client wiring is developer-specific and should not be committed.

1. **Edit** source files in `src/`
2. **Build:** `pnpm build` (TypeScript → `dist/` via tsup)
   - Or `pnpm dev` for watch mode (auto-rebuild on save)
3. **Test with an MCP client** using local env vars and `dist/cli.js`
4. **Iterate**

### Commands

```bash
pnpm build        # Compile TypeScript
pnpm dev          # Watch mode (auto-rebuild)
pnpm dev:http     # Build + start HTTP server
pnpm typecheck    # TypeScript type checking
pnpm test         # Run vitest tests
pnpm start        # Run dist/cli.js directly
```

### Environment

Common env vars:
- `HYPERMAIL_DATA_DIR` — directory for token/account storage
- `HYPERMAIL_KEY` — encryption key/passphrase for token storage
- `HYPERMAIL_OUTLOOK_CLIENT_ID` — optional Azure/Entra app registration client ID
- `HYPERMAIL_OUTLOOK_TENANT_ID` — optional Azure/Entra tenant ID
- `HYPERMAIL_GMAIL_CLIENT_ID` — Google OAuth client ID, required when adding Gmail accounts
- `HYPERMAIL_GMAIL_CLIENT_SECRET` — Google OAuth client secret, if issued

## Key Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `@microsoft/microsoft-graph-client` — Outlook/Microsoft 365 Graph API
- `@azure/msal-node` — OAuth device-code authentication
- `zod` — input validation for tool parameters
