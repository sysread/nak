# Attachments

Nak lets you attach files to a message so the model can read them
alongside your text. Images, PDFs, spreadsheets, source code, notes —
any file type, capped at 10 MB each and 25 MB total per message.

## Attaching a file

There are three ways to queue a file for the next send:

- **Paperclip button** in the composer toolbar. Opens your OS file
  picker; pick one or several files.
- **Paste**. Copy an image (or a file on Windows/macOS), focus the
  message box, and paste. Text pastes still work normally — only
  file-pasted content becomes an attachment.
- **Drag & drop**. Drag one or more files from your desktop onto the
  composer. An accent-tinted overlay highlights the drop zone while
  you hover.

Each queued file appears as a chip above the textarea. A dashed chip
means Nak is still processing the file (compressing a large image,
asking Venice to extract text from a document). When Nak shrinks an
oversized image the chip shows the result - "Reduced from 2.7 MB to
845 KB" - so you can see what was saved. The chip fills in once
processing finishes; the send button unlocks when every chip is ready.

Click the × on a chip to remove it before sending.

## What the model actually sees

- **Images**. The **Smart** tier (Qwen 3.6 Plus) is natively vision-
  capable, so Nak inlines the pixels directly and the model sees the
  image first-hand. **Balanced** and **Fast** are text-only, so Nak
  automatically calls a vision sub-model on the main model's behalf:
  the model receives a note listing the attached image filenames and
  calls the built-in `analyze_image` tool to get a text description.
  You do not need to switch tiers to send an image; the routing is
  automatic per tier.
- **Documents, code, and other files**. Nak calls Venice's text
  parser at upload time to pull readable text out, then prepends
  that text to your message as a fenced block tagged with the
  filename. The model sees the filename alongside the extracted
  content.
- **Cross-turn recall**. Every chat turn the model also receives a
  short summary of every file ever attached to the conversation -
  live filenames it can still inspect, plus filenames of any deleted
  attachments so it can tell you "I had that file but it's been
  removed" rather than pretending it never existed. This means you
  can re-ask about an image you sent five turns ago and the model can
  re-analyze it without you re-uploading.

## After sending

Images you attach (and images Nak generates, below) render as a large
preview under the message - about 85% of the bubble width - so you can
actually see them in the conversation rather than squinting at a
thumbnail. Click an image preview to open the full-resolution
image in a new tab.

Other files show up under your message as a download chip:

- **Click the filename** to download the original file. Nak
  preserves the original name.
- **Click "Text"** (when present) to open a right-side drawer with
  the extracted text, so you can read what the model read.

## Generating images

Nak can also create images for you. Enable the **Images** toolbox in
the [toolbox popover](./chat.md#toolboxes), then ask for a picture -
"draw me a watercolor fox in a snowy forest." Nak writes a detailed
prompt and sends it to Venice's image model. The picture appears as a
large preview in its own card just below the generation step, with a
brief loading placeholder while the image downloads - then it renders
exactly like an image you uploaded yourself.

- Nak often turns the Images toolbox on by itself when you clearly
  ask for a picture, the same way it reaches for other capabilities
  mid-conversation. If nothing happens, check the toolbox is enabled.
- Generated images are **stored exactly like your uploads** - kept in
  your Nak storage and managed from the same Artifacts tab (below).
- Because a generated image is a normal attachment, you can ask Nak
  to look at it again later ("what's in the background of that image?")
  and it will inspect the picture it made, just like re-asking about
  an uploaded image.
- Generating an image spends Venice credits, which is why it sits
  behind a toolbox rather than firing on every message.
- Nak asks Venice to omit its watermark on generated images. Some
  Venice plans force the watermark regardless, so it may still
  appear depending on your account.

## Managing your files (the Artifacts tab)

Your files are **kept until you delete them** - nothing expires on a
timer. (Images are shrunk on upload, so they don't pile up the way
full-resolution originals would.)

To review or clean up everything you've attached, open the
**Artifacts** tab in the left drawer. It lists every file across all
your conversations, newest first, with:

- **Search** by filename.
- **Filter** by type - All, Images, or Files.
- **Sort** by Newest or Largest, so the biggest space hogs are easy
  to find.
- A **thumbnail** for images and the **conversation** each file
  belongs to. Click a row to jump straight to that conversation.
- A **trash button** to delete a file.

When you delete a file:

- The file itself is removed from Nak's storage (your space is freed).
- The filename, size, and extracted text **stay** in the conversation
  so it's still legible — you'll see the filename with a small clock
  icon, and the "Text" button keeps working.

Deleting is permanent and can't be undone.

## Size limits

- **Per attachment**: 10 MB.
- **Per message**: 25 MB total across all attached files.
- **Per message**: up to 20 files.

Large images are compressed automatically before storage: Nak caps
the long edge at 2048 px (vision models don't benefit from more) and
re-encodes toward roughly 1 MB, so a multi-megabyte phone photo lands
small without you doing anything. It's a target, not a hard cut - a
detailed image may stay a little over, and an image that's already
small passes through untouched.

## Where to go next

- [The chat interface](./chat.md) — composer, streaming, and the
  rest of the main view.
- [Models & reasoning](./models.md) — tier tradeoffs and
  capabilities.
- [What runs in the background](./background.md) — including the
  orphan storage sweep that tidies up after deleted conversations.
