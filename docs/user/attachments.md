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
means Nak is still processing the file (downscaling a large image,
asking Venice to extract text from a document). The chip fills in
once processing finishes; the send button unlocks when every chip is
ready.

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
  live filenames it can still inspect, plus filenames of any expired
  attachments so it can tell you "I had that file but its data has
  been reclaimed" rather than pretending it never existed. This
  means you can re-ask about an image you sent five turns ago and
  the model can re-analyze it without you re-uploading.

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
prompt, sends it to Venice's image model, and attaches the result to
its reply as a large preview, exactly like an image you uploaded
yourself.

- Nak often turns the Images toolbox on by itself when you clearly
  ask for a picture, the same way it reaches for other capabilities
  mid-conversation. If nothing happens, check the toolbox is enabled.
- Generated images are **stored and expired on the same 30-day
  schedule as your uploads** (see below) - they're kept in your Nak
  storage, freed automatically a month after the conversation goes
  quiet.
- Because a generated image is a normal attachment, you can ask Nak
  to look at it again later ("what's in the background of that image?")
  and it will inspect the picture it made, just like re-asking about
  an uploaded image.
- Generating an image spends Venice credits, which is why it sits
  behind a toolbox rather than firing on every message.
- Nak asks Venice to omit its watermark on generated images. Some
  Venice plans force the watermark regardless, so it may still
  appear depending on your account.

## Expiration

Attachments are reclaimed 30 days after a conversation's last
update. After that:

- The file itself is deleted from Nak's storage (your space is
  freed).
- The filename, size, and extracted text **stay** so the
  conversation is still legible — you'll see the filename with a
  small clock icon, and the "Text" button keeps working.

Keep the conversation alive (reply to it) to reset the clock; any
new message resets the 30-day timer for every attachment in that
thread.

## Size limits

- **Per attachment**: 10 MB.
- **Per message**: 25 MB total across all attached files.
- **Per message**: up to 20 files.

Images over 2048 px on the long edge are downscaled automatically
before storage — vision models don't benefit from more, and the
downscale keeps row sizes predictable.

## Where to go next

- [The chat interface](./chat.md) — composer, streaming, and the
  rest of the main view.
- [Models & reasoning](./models.md) — tier tradeoffs and
  capabilities.
- [What runs in the background](./background.md) — including the
  scheduled storage cleanup that reclaims expired attachments.
