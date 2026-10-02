# Hosting hypermail-mcp

This server runs either as a local stdio MCP (per-user) or as a hosted HTTP
service. This doc covers the HTTP case.

HTTP has no built-in authentication. Run it only on a private network or behind
an authenticated, authorized reverse proxy. Do not expose the backend port
directly to the public internet.

## Quick start

```bash
HYPERMAIL_KEY=$(hypermail-mcp generate-key) \
HYPERMAIL_DATA_DIR=/var/lib/mcp \
HYPERMAIL_OUTLOOK_CLIENT_ID=<your-entra-app-id> \
hypermail-mcp --http --host 0.0.0.0 --port 3000
```

Endpoint: `POST/GET/DELETE http://<host>:3000/mcp` (Streamable HTTP).

Sessions are tracked by the `Mcp-Session-Id` response header. Clients must echo
it back on subsequent requests; on `DELETE /mcp` with that header the session is
closed.

## Required environment

- `HYPERMAIL_KEY` — set explicitly when hosted. Use `hypermail-mcp generate-key`
  for a base64 32-byte key, or provide any passphrase (SHA-256 derives a key).
  Losing this key makes the existing accounts file unreadable.
- `HYPERMAIL_DATA_DIR` — a persistent, writable directory. The encrypted
  accounts blob lives at `${DIR}/accounts.json.enc`.
- Provider credentials only for providers you use. Outlook can use the built-in
  public client for local/device-code flows, but hosted operators should set
  `HYPERMAIL_OUTLOOK_CLIENT_ID` to an Entra app they control.

## Docker (minimal)

```dockerfile
FROM node:22-alpine
RUN npm install -g hypermail-mcp
RUN mkdir -p /var/lib/mcp
VOLUME /var/lib/mcp
EXPOSE 3000
CMD ["hypermail-mcp", "--http", "--host", "0.0.0.0", "--port", "3000", "--data-dir", "/var/lib/mcp"]
```

```bash
# Pass values through from your shell or deployment secret store.
docker run -d -p 127.0.0.1:3000:3000 \
  -e HYPERMAIL_KEY \
  -e HYPERMAIL_OUTLOOK_CLIENT_ID \
  -v hypermail-data:/var/lib/mcp \
  hypermail-mcp
```

## Reverse proxies

Before publishing `/mcp`, authenticate and authorize access at the proxy and
restrict direct backend access with private networking/firewall rules. TLS
alone does not restrict access to the stored mail accounts.

Preserve `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Content-Type`, and `Accept`
headers in both directions, support SSE streaming without response buffering,
and allow GET, POST, and DELETE. Validate allowed Host and Origin values at
this boundary; do not trust arbitrary client-supplied forwarded headers.

`HYPERMAIL_KEY` encrypts stored accounts at rest, and session IDs identify MCP
sessions: neither authenticates callers. `HYPERMAIL_TOOLS_ENABLED` and
`HYPERMAIL_TOOLS_DISABLED` limit available tools, not who may invoke them.

If hosted Gmail OAuth requires a public callback, limit that exception to
`/oauth/gmail/callback` (the existing callback path), not `/mcp` or the whole
backend. Gmail's provider owns OAuth state validation.

POST bodies are limited to 16 MiB. Malformed JSON returns 400; oversized bodies
return 413. Expired session IDs return 404: initialize a new session rather than
reusing the old ID. A request without a session must first initialize.
