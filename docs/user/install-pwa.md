# Install as a PWA

Nak is a Progressive Web App — your browser can install it so it
launches like a native app and works when you're offline.

## Installing on desktop

## Installing on iOS

## Installing on Android

## What works offline

Once Nak is installed, the app itself opens with no connection - the
interface is cached on your device. What it can *show* you offline
depends on what you saved ahead of time.

**Saving things for offline.** Mark a wiki article or a recipe as a
**favorite** (and, for recipes, "upcoming" counts too). Anything in
those sets is mirrored onto your device the next time you're online,
so you can open it later with no signal. Favoriting is the gesture:
the wildfire-evacuation article you star today is readable from the
trailhead tomorrow.

- The sidebar's **Favorites** section (and the recipe **Upcoming**
  section) is the set saved for offline use.
- Saving syncs in the background while you're connected. Favorite
  something, stay online a moment, and it's stored.
- When you're offline, a small banner appears at the bottom of the
  screen telling you so, and how many articles and recipes are
  available.

**What works with no connection:**

- Opening the app and navigating around.
- Reading any favorited article and any favorited or upcoming recipe,
  including its text, ingredients, and steps.
- The in-app **Help** manual (these pages).

**What needs a connection:**

- Chatting with the assistant (it talks to Venice over the network).
- Editing, creating, or deleting articles and recipes, and changing
  favorites - these are disabled while offline, with a tooltip saying
  so. Reconnect and they work again.
- **Recipe photos** - they aren't stored offline, so a recipe you
  open with no signal shows "Photos are only available online" in
  place of the strip. The text and steps are all there.
- Anything you never favorited - if it wasn't saved, it can't load
  without a connection.

**Across devices.** Favoriting on your laptop saves it on your laptop;
open Nak on your phone while online and it saves there too. Un-favorite
something and it's dropped from each device's offline copy the next
time that device syncs. An offline device keeps whatever it last
saved - going offline never wipes your saved copies; only an
un-favorite (seen while online) removes them.

## Sharing into Nak from other apps

Once Nak is installed on your home screen (or desktop), it registers
itself with the operating system as a share destination. That means
when you tap the share button in another app — a browser, a reader,
a notes app — Nak appears in the share sheet next to the usual
suspects. Picking it opens Nak with the shared content prefilled in
the composer, ready for you to edit and send.

### What comes through

- **Links.** Sharing a URL drops the page title and the link itself
  into the composer. If the source app includes selected text (for
  example a highlighted excerpt from an article), that lands in the
  composer too.
- **Plain text.** Any selection you share as plain text becomes the
  prompt body.
- **Text-like files.** Source code, markdown, JSON, CSV, and other
  text files (up to 256 KB) are inlined inside a fenced code block
  so the model can read them directly in the prompt. Larger text
  files are routed through the attachment pipeline instead, so a
  single share can't blow past the model's context window.
- **Other files.** Images, audio, PDFs, and other binary files -
  plus any text file too big to inline - land as attachments: the
  same chips you'd see if you'd picked the files from the composer's
  paperclip button or dragged them into the textarea. Images are
  downscaled and readied for vision models; PDFs and other documents
  are run through text extraction so their contents reach the model.
  Remove a chip from the composer if you didn't mean to share it.

### Where the content lands

- If a conversation is already open, the shared content is appended
  to whatever you were typing (you don't lose draft text).
- If Nak wasn't running, it launches straight into the chat screen
  with the shared content waiting in the composer.
- If you're signed out when the share arrives, the content is held
  until you sign in - nothing is sent anywhere or written to
  Supabase until you press send.

### Platform notes

- **Android (Chromium-based browsers).** Full support for text,
  links, and files. Works reliably once the PWA is installed.
- **iOS (Safari 16.4+).** Links and text work. File sharing is
  limited and inconsistent across iOS versions; a shared image may
  come through as a link to the file, or not at all, depending on
  the source app. If nothing appears in the composer after sharing,
  try sharing the same item as a link or as copied text.
- **Desktop browsers.** The share sheet is mobile-first; on desktop
  most OSes don't surface installed PWAs there. Use copy-paste
  instead.

Sharing only works while the PWA is installed. A plain browser tab
visiting Nak won't show up as a share destination.

## Updating the installed app

## Uninstalling

## Where to go next

- [Getting started](./getting-started.md) — the one-time setup that
  follows install.

---
Back to the [index](./README.md).
