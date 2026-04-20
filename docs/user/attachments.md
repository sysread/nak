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

- **Images**. Inlined into the request on vision-capable tiers (see
  the model picker — the **Balanced** tier is vision-capable today).
- **Documents, code, and other files**. Nak calls Venice's text
  parser at upload time to pull readable text out, then prepends
  that text to your message as a fenced block tagged with the
  filename. The model sees the filename alongside the extracted
  content.

If you try to send an image while a non-vision tier is selected, Nak
blocks the send and explains which file is unreadable — either
switch to a vision tier or remove the file.

## After sending

Each attached file shows up under your message as a download link:

- **Click the filename** to download the original file. Nak
  preserves the original name.
- **Click "Text"** (when present) to open a right-side drawer with
  the extracted text, so you can read what the model read.

## Expiration

Attachments are reclaimed 30 days after a conversation's last
update. After that:

- The file's binary is removed from Nak's database (your storage is
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
- [Models & reasoning](./models.md) — which tier supports vision.
- [What runs in the background](./background.md) — including the
  attachment-expiry worker that reclaims storage.
