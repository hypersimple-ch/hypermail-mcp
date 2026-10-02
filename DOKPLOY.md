# Deploy hypermail-mcp to Dokploy

Dockerfile-only deployment — no compose file, no port bindings, no manual labels. Everything is configured in the Dokploy UI.

## Prerequisites

- A domain pointed at your VPS (e.g. `mail-api.example.com`)
- Dokploy installed and connected to your Git provider
- An authentication/authorization boundary for `/mcp`, or private-network-only access

## Step-by-step

### 1. Create the Application

1. **Create Service** → **Application**
2. Select your Git provider, repository, and branch
3. **Build Path**: `/` (root of repo — that's where the Dockerfile lives)
4. **Save**

### 2. Set the encryption key

Go to the **Environment** tab and add:

| Variable | Value |
|----------|-------|
| `HYPERMAIL_KEY` | Run `hypermail-mcp generate-key` or `openssl rand -base64 32` and paste the output |

This key encrypts your OAuth tokens at rest. Back it up — if lost, you'll need to re-authenticate every email account.

### 3. Configure persistent storage

Go to **Advanced** → **Mounts** → add a bind mount:

| Host path | Container path |
|-----------|---------------|
| `../files/data` | `/var/lib/mcp` |

This persists your encrypted tokens across redeploys. Dokploy creates the host path automatically on first deploy.

> `../files/` is Dokploy's persistent directory for this application. Anything there survives redeploys.

### 4. Add a domain

Go to the **Domains** tab → **Add Domain** → enter your domain (e.g. `mail-api.example.com`).

Dokploy provisions routing and TLS, but those are not authentication. Before
publishing the domain, configure proxy authentication and authorization for
`/mcp`, and restrict direct access to the backend/container port using private
networking/firewall rules. Validate allowed Host and Origin values at the proxy.
Preserve `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Content-Type`, and `Accept`
headers in both directions, retain SSE streaming without response buffering,
and allow GET, POST, and DELETE.

`HYPERMAIL_KEY` is encryption at rest, not caller authentication. MCP session
IDs are not credentials. `HYPERMAIL_TOOLS_ENABLED`/`HYPERMAIL_TOOLS_DISABLED`
provide tool filtering only; they are not an HTTP security boundary.

If public hosted Gmail OAuth is needed, exempt only the existing
`/oauth/gmail/callback` path from MCP access restrictions. OAuth state validation
remains provider-owned. Do not expose the whole backend for this exception.

### 5. Deploy

Click **Deploy**. Check **Logs** — you should see:

```
[hypermail-mcp] listening on http://0.0.0.0:3000/mcp
```

### 6. Verify

```bash
# Supply your boundary's authentication credentials through its documented mechanism.
curl https://your-domain.com/mcp
```

An unauthenticated external request must be rejected by your boundary. An
authorized request without an MCP session returns 400 until it initializes.
Use an MCP client to initialize, list tools, and DELETE its session; reusing that
expired session ID must return 404. TLS or a successful unauthenticated request
alone is not proof of a safe deployment.

## Connecting clients

```json
{
  "mcpServers": {
    "hypermail-http": {
      "type": "streamableHttp",
      "url": "https://mail-api.example.com/mcp"
    }
  }
}
```

## Provider credentials (optional)

Set these in the **Environment** tab — only for providers you use:

| Variable | Provider |
|----------|----------|
| `HYPERMAIL_OUTLOOK_CLIENT_ID` | Outlook |
| `HYPERMAIL_OUTLOOK_TENANT_ID` | Outlook |
| `HYPERMAIL_GMAIL_CLIENT_ID` | Gmail |
| `HYPERMAIL_GMAIL_CLIENT_SECRET` | Gmail |
| `HYPERMAIL_GMAIL_REDIRECT_URI` | Gmail hosted OAuth callback |

For hosted Gmail OAuth, create a Google OAuth **Web application** client and
register the exact callback URL, for example
`https://mail-api.example.com/oauth/gmail/callback`. Set the same value as
`HYPERMAIL_GMAIL_REDIRECT_URI`. Google's official Gmail MCP also uses
OAuth 2.0; service accounts only work for Google Workspace domain-wide
delegation and won't access consumer `@gmail.com` inboxes.

## What's in the Dockerfile

| Instruction | Purpose |
|-------------|---------|
| `COPY . .` | Copies entire repo into `/app` |
| `pnpm install && pnpm build && pnpm prune --prod` | Single install + build + dev dep cleanup |
| `EXPOSE 3000` | Internal port (Dokploy uses this for routing) |
| `HEALTHCHECK` | Docker checks `localhost:3000/mcp` every 30s |
| `ENV NODE_ENV=production` | Production mode |
| `CMD node dist/cli.js --http ...` | Starts MCP server on `0.0.0.0:3000` |
