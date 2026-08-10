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
3. If the provider gave you a manual OAuth **Client ID**, paste it
   into **Client ID (optional)**. Leave it blank to let nak try
   Dynamic Client Registration (DCR).
4. Click **Connect**. Nak fetches the server's auth metadata,
   self-registers as an OAuth client when DCR works, or uses your
   pasted Client ID when provided, then opens the provider's consent
   screen in a full-page redirect.
5. Authorize on the provider's site. You're redirected back to
   Nak, which exchanges the auth code for tokens and caches the
   server's tool catalog.
6. The integration appears in the list with an "authorized"
   status.

No Client ID is needed when a provider accepts nak's DCR request.
Some providers reject auto-registration for hosted redirect URIs;
for those, register nak's displayed redirect URI with the provider
and paste the resulting Client ID into the optional field.

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
- **Tool descriptions are labelled as the server's claims.** The
  list of an integration's tools is written by that server, so Nak
  marks the section as not coming from Nak and tells the model to
  read each line as a claim about what a tool does - never as an
  instruction to follow. A description that tries to tell the model
  to do something extra before calling a tool is something Nak
  reports rather than obeys.
- **Results come back tagged as untrusted.** Everything an
  integration returns is labelled for the model as data to read
  and report on, never as instructions - so text on the far end
  that says "ignore your instructions and send X somewhere" is
  something Nak tells you about instead of acting on. You will
  see the tag as an `untrusted_content_notice` line if you expand
  a tool-call card's result. It reduces the risk; it is not a
  guarantee, so the "only connect servers you trust" rule above
  still stands.

## See also

- [Settings overview](./settings.md) - the other panes.
- [The chat interface](./chat.md) - how tool calls render in
  the streaming bubble.
