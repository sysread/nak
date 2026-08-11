# Getting started

The fastest path from "I just opened Nak" to "I'm chatting with a
model." This page walks you through the one-time setup: creating your
Supabase project, seeding the Venice API key into it, signing in,
and sending your first message.

## What you'll need

- A **Supabase** account and a new project on it. The free tier
  is fine. Nak stores your conversations, memories, recipes, and
  attachments there.
- A **Venice.ai** account and API key. Nak runs chat, image
  generation, and its background agents against Venice. (Embeddings
  run locally in the edge function and don't need Venice.) The key
  gets seeded into your Supabase project once and held server-side;
  you do not enter it into the browser.

## Creating your Supabase project

## Seeding the Venice API key

The Venice key lives in your Supabase project's `app_config`
table, not in your browser. The edge function nak ships reads it
server-side when it talks to Venice. One row, set once by you (or
the friend / family member who owns the project), works for every
person you invite onto the project later.

## First-time sign-in

When you open Nak for the first time, it asks for your **Supabase
URL** and **publishable key**. Both come from your Supabase
project's API settings page; the publishable key is RLS-safe and
fine to paste into a client app. Nak stores them in this
browser's `localStorage` so you don't have to re-enter them on
every refresh.

After that, sign in with your Supabase account email and password
(or sign up, if this is your first time on the project).

## Sending your first message

## Where to go next

- [The chat interface](./chat.md) - what the composer and the
  response area can do.
- [Settings overview](./settings.md) - tour of the other panes.
- [Security model](./security.md) - what's stored locally, what's
  stored remotely, and what the publishable key actually
  protects.

---
Back to the [index](./README.md).
