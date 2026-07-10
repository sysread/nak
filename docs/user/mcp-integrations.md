# MCP integrations

Nak can connect to external services through the Model Context
Protocol (MCP) - an open standard for letting AI tools talk to
remote data sources. Once connected, the assistant can use that
service's tools the same way it uses the built-in ones (memory
search, cookbook, wiki, etc.).

## What an integration is

An MCP integration is a remote server URL you paste into
**Settings - Integrations**. Nak discovers what the server can
do, runs the OAuth consent flow, and stores the connection. The
server's tools then appear as a gated "toolbox" the assistant
can toggle on for any thread - same shape as the cookbook or
wiki toolboxes.

Common integrations:

- [Fastmail](https://www.fastmail.com/blog/an-mcp-server-for-fastmail/)
  - read, write, and send mail; manage contacts and calendars
  through Fastmail's hosted MCP server.

Any MCP server that supports remote streamable-HTTP transport +
OAuth can be connected the same way.

## Adding an integration

1. Open **Settings - Integrations**.
2. Enter a **label** (any name you want; shows in the settings
   list and the toolbox popover) and the **server URL** the
   provider gave you (e.g. `https://api.fastmail.com/mcp`).
3. Click **Connect**. Nak fetches the server's auth metadata,
   self-registers as an OAuth client (when the server supports
   RFC 7591 Dynamic Client Registration - Fastmail does), and
   opens the provider's consent screen in a full-page redirect.
4. Authorize on the provider's site. You're redirected back to
   Nak, which exchanges the auth code for tokens and caches the
   server's tool catalog.
5. The integration appears in the list with an "authorized"
   status.

No client_id to paste, no developer console to wade through -
the discovery + registration happen automatically when the
server supports DCR. Providers that don't support DCR fall
through to a manual client_id step (not yet implemented).

## Using an integration's tools

Once authorized, the integration appears as a gated toolbox
named `mcp:<label>` in the composer popover (the same menu where
you toggle cookbook, memories, wiki, etc.). Toggle it on for a
thread and the assistant can call that integration's tools in
that conversation.

The tools work the same as every built-in tool:

- The assistant decides when a tool call is worth making and
  calls it transparently (you see the tool name + arguments in
  the streaming bubble).
- The call happens server-side - Nak's edge function holds the
  bearer token and dispatches against the MCP server. Your
  browser never sees the access token.
- Tool results render inline.

## Managing integrations

From **Settings - Integrations**:

- **Delete** removes the integration, its stored tokens, and
  cached tool catalog. The provider's site may still list Nak
  as a connected app - revoke there too if you want to disconnect
  fully (Fastmail: Settings - Privacy & Security - Connected
  apps).
- **Re-authorize** (if a token rotates out or the server
  revokes access) re-runs the OAuth flow.

## Security

- **Your tokens never touch your browser.** All MCP tool calls
  happen server-side in the Supabase edge function - the function
  holds the bearer token, dispatches against the MCP server, and
  returns the result. The browser only sees the integration's
  label, URL, and auth status.
- **You scope the access at consent time.** The provider's OAuth
  screen names exactly what the integration can do (read-only,
  write, send). Pick the minimal scope you need.
- **You can disconnect at any time** - delete the integration in
  Nak and revoke the app on the provider's site.
- **Arbitrary server URLs are a trust decision.** Pasting a URL
  means nak makes authenticated calls to that server and injects
  the server's tool descriptions into the chat system prompt. A
  malicious server could attempt prompt injection through its
  tool descriptions. Only connect servers you trust.

## See also

- [Settings overview](./settings.md) - the other panes.
- [The chat interface](./chat.md) - how tool calls render in
  the streaming bubble.
