# Library

The Library is where you keep **documents** you want Nak to remember
for the long haul - your HOA agreement, insurance policies, contracts,
tax documents, a lease, a warranty, anything text can be pulled from.
Upload a file once and it becomes permanent, searchable reference
material the assistant can read to answer your questions.

The Library is a peer to Chats, Memory, the Wiki, and the Cookbook -
its own tab in the left drawer.

## Library vs. attachments

Nak has two ways to give the assistant a file, and they're for
different jobs:

- **Attachments** (the paperclip in the composer) ride along with a
  single message. They're great for "look at this and tell me what you
  think" in the moment. They stay until you delete them (from the
  Artifacts tab), and images are shrunk on upload to keep storage lean.
- **Library documents** are permanent. They don't expire, they live in
  their own tab, and the assistant can search across all of them at
  once. This is the right home for paperwork you'll want to ask about
  weeks or months later.

## Uploading a document

1. Open the **Library** tab in the left drawer.
2. In the main panel, choose a file.
3. Give it a **title** (defaults to the filename) and a short
   description of **what it is for** - e.g. "2024 Aetna health
   insurance policy" or "HOA covenants and restrictions". The
   description helps both you and the assistant find it later.
4. Save it to the Library.

When you upload, Nak extracts the document's text, which usually takes
a few seconds. A document shows **Processing** until extraction
finishes, then it's immediately searchable. A document is marked **Not
searchable** if the file had no extractable text (a scanned image with
no text layer, for example) - the original is still downloadable in
that case.

Supported files are anything text can be extracted from: plain text,
Word documents, PDFs, and similar. The original file is stored
privately and is only reachable by you.

## Asking about your documents

You don't have to do anything special. Just ask. When a question would
be answered by your paperwork - "what's my deductible?", "does my
policy cover water damage?", "what does the HOA say about fences?" -
the assistant searches inside your documents for the relevant section
and answers from it, even inside a long PDF. It cites which document
the answer came from.

The assistant searches the full text, so a forty-page contract is just
as findable as a one-page letter - the answer doesn't get lost.

## Managing documents

From a document's page in the Library panel you can:

- **Rename it or edit the description** to clarify what it is and what
  it's for (the **Edit** button).
- **Download the original** file.
- **Delete** the document - this permanently removes its text and the
  stored original.

The assistant can also help you manage the Library in conversation. It
can:

- **Save a file you attached to the chat** as a permanent Library
  document ("keep this insurance PDF so you can reference it later").
- **Update** a document's title or description.
- **Delete** a document when it's obsolete ("I switched insurers,
  delete the old policy").

The assistant can't upload files on its own - it can only save a file
you've already attached to the conversation. To replace a document's
contents (a renewed policy, an amended contract), upload the new file.

## Privacy

Library documents are private to your account, stored in encrypted
form on your Supabase backend, and only reachable by you. See the
[security model](./security.md) for how your data is protected.
