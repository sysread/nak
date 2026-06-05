# Security model

Nak is bring-your-own-infrastructure: your Supabase project
holds your data, the Venice API key on your Supabase project
pays for your own usage. This page covers what's stored where
and what protects it.

## What's stored where

- **Browser `localStorage`** holds the **Supabase URL** and
  **publishable key** in plaintext under `nak:config:v2`. The
  publishable key is RLS-safe; it's safe to ship in a client app.
- **Browser `localStorage`** also holds the Supabase auth
  session (JWT + refresh token) under
  `sb-<project>-auth-token`, owned by the supabase-js client.
- **Browser `sessionStorage`** holds the id of the last thread
  you had open, so a refresh re-opens it. Cleared on sign-out.
- **Supabase tables** hold everything else: threads, messages,
  attachments metadata, memories, recipes, wiki articles,
  profile settings.
- **Supabase Storage buckets** hold the bytes of any files you
  attach (chat attachments, library docs, recipe photos).
- **The Venice API key** lives in the project's `app_config`
  table. The nak edge function reads it server-side; the
  browser never sees it.

## What RLS does for you

Every Supabase table has Row Level Security enabled with a
policy of `auth.uid() = user_id`. The publishable key by
itself can read *nothing* - it always needs a signed-in
session, and the session's JWT pins every read to the rows
that user owns. Sharing a Supabase project with someone is
safe: they sign in with their own Supabase account, get their
own user id, and the same RLS policies isolate their data
from yours.

## Signing out

The **Sign out** button in Settings &rarr; About signs out of
the Supabase auth session and clears the last-thread pointer.
The localStorage config (URL + publishable key) stays, so the
sign-in screen on the next visit is one step instead of two.
The in-memory profile / system-prompt state is reset so a
subsequent sign-in-as-someone-else does not see the previous
account's preferences before the new account's settings load.

## Where to go next

- [Export & import](./export-import.md) - moving the
  Supabase config to another browser.
- [Settings overview](./settings.md) - tour of the panes,
  including Security and API keys.

---
Back to the [index](./README.md).
