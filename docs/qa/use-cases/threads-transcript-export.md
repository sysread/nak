# threads-transcript-export

Downloading a conversation as a Markdown transcript from the top bar
(desktop button + mobile overflow menu) and from a thread row's kebab
menu, including the filename slug and the content filtering.

## Covers

- Transcript export builders and gating
  ([chat](../../dev/chat.md), `src/lib/ui/transcript-export.ts`)
- Top-bar action cluster / overflow menu
  ([components](../../dev/components.md), `TopBarActions.svelte`)

## Preconditions

- Local stack running via `mise run dev-start`; signed in as
  `dev@nak.local` / `devpass123`.
- At least one conversation with a completed exchange (a user turn
  and an assistant reply). If none exists, send "say hi" in a new
  conversation and wait for the reply and the auto-title.
- A browser profile where downloads land in a known folder.

## Steps

1. Open the conversation from the precondition on a desktop-width
   window (>720px). Note its title in the top bar.
2. Click the download button (arrow-into-tray icon) at the top
   right, next to the logs toggle.
3. Open the downloaded file in a text editor.
4. Click **New conversation** (do not send anything). Observe the
   download button.
5. Return to the first conversation. Open **Daily digest** (calendar
   button). Observe the download button, then close the digest.
6. Narrow the window below 720px (or use a phone). Open the three-dot
   overflow menu in the top bar.
7. Choose **Download transcript** from the overflow menu.
8. Restore desktop width. In the drawer, open the three-dot menu on a
   conversation that is NOT the active one and choose **Download
   transcript**.
9. Archive a conversation, open its row's three-dot menu.

## Expected

- Step 2: a `.md` file downloads, named as the lowercased,
  hyphenated conversation title (e.g. `quick-greeting.md`).
- Step 3: the file opens with `# <title>`, a `Created:` line, then
  `## User - <timestamp>` and `## Assistant - <timestamp>` sections
  containing the visible message texts. No system prompt, no tool
  call/result payloads. If a reply cited web sources, its section
  ends with a numbered `Sources:` list of Markdown links and the
  body's superscript markers read as `[1]`, `[2]`, ... instead of
  `^1^`.
- Step 4: the download button is disabled (draft, no messages).
- Step 5: the download button is disabled while the digest panel is
  open; enabled again after closing it.
- Step 6: the overflow menu lists **Download transcript** beneath
  **Daily digest**; no standalone download button crowds the bar.
- Step 7: the same `.md` file downloads as in step 2.
- Step 8: a transcript for THAT thread downloads (title-slug
  filename matches the row, not the active conversation).
- Step 9: the archived row's menu offers **Download transcript**
  and it downloads normally.

## Cleanup

- Delete the downloaded `.md` files.
- Restore any conversation archived in step 9.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
