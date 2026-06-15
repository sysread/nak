# Export & import

Moving your Supabase keys to another browser, another device, or
a reinstalled browser profile. The Venice API key is held
server-side in your Supabase project's `app_config` table and
read by the edge function at request time, so there's nothing to
export on that front - any browser that's signed into the same
Supabase project reaches the same Venice key automatically.

## What the export file contains

A JSON object with two fields - the **Supabase URL** and the
**Supabase publishable key**. That's it. The publishable key is
RLS-safe by design (every table policy is `auth.uid() = user_id`),
so the file is roughly equivalent to a bookmark plus your project
id. It does not contain your account password or your Supabase
JWT, so importing the file does not sign you in - you still go
through the regular sign-in screen after importing.

## Exporting

Settings &rarr; **API keys** &rarr; **Export**. The button
downloads a timestamped `nak-config-<timestamp>.json` file with the
two fields above.

## Importing on a new browser

Open Nak on the new browser. On first launch you'll see the
Setup screen asking for the Supabase URL and publishable key.
There's an **Import** button at the bottom - pick the JSON file
you saved and Nak fills both fields. Then sign in with your
Supabase account credentials.

## Keeping the export file safe

The Supabase URL and publishable key are not secrets in the
RLS-key sense - anyone who has them still has to sign in through
Supabase auth before they can read your data - but they identify
your project. Treat the file like a bookmark to a sensitive site:
no need to encrypt it, but don't post it publicly.

## Where to go next

- [Security model](./security.md) - what the publishable key
  actually protects, and what RLS does for you.
- [Getting started](./getting-started.md) - the matching import
  step during first-time setup.

---
Back to the [index](./README.md).
