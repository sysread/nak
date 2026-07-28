# Attachments: PDF page rendering and vision reads

## Covers

Browser-side PDF rasterization at attach time (`src/lib/pdf-pages.ts`,
[dev: attachments](../../dev/attachments.md) "PDF page rendering"), the
`message_attachment_pages` table + its RLS and its share of the
`attachments` bucket ([dev: file-storage](../../dev/file-storage.md)), the
`analyze_pdf_page` chat tool and `analyze_image`'s mime-aware miss
diagnostic ([dev: tools](../../dev/tools.md)), the `Viewable pages` line in
the `<thread_attachments>` system block, the pre-send guard accepting a
text-less PDF, and page-object reclamation on the Artifacts-tab delete and
the `attachment-gc` sweep.

The load-bearing case is the **scanned PDF**: no text layer, so before
page rendering the composer refused to send it at all.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (text extraction and the vision
  sub-calls both go to Venice).
- Three PDFs on disk:
  - `text.pdf` - an ordinary text-native PDF, a handful of pages.
  - `scan.pdf` - a **scanned** PDF with no text layer (print a page and
    photograph/scan it, or export images-only from a scanner app).
    Verify it has no text layer first: selecting text in a viewer should
    select nothing.
  - `chart.pdf` - a text-native PDF with a **chart or diagram** on a
    known page (say page 2) whose values do NOT appear in the prose.
- A model profile whose main model is text-only, so the vision path has
  to go through the tool rather than inlining (either tier works; a
  text-only main model makes the tool call unambiguous in the UI).

## Steps

1. **Part A - attach-time rendering.** In a new thread, attach `text.pdf`
   with the paperclip. Watch the chip.
2. Send the message with the text `What is this document about?`.
3. Confirm the rows landed:

   ```sql
   select a.filename, a.page_count,
          a.extracted_text is not null as has_text,
          (select count(*) from message_attachment_pages p
            where p.attachment_id = a.id) as rendered_pages
     from message_attachments a
     join messages m on m.id = a.message_id
    where m.thread_id = '<thread>';
   ```

4. Confirm the page objects exist in the bucket under
   `<uid>/<attachment_id>/pages/` (Storage browser, or
   `select name from storage.objects where bucket_id = 'attachments'
   and name like '%/pages/%';`).

5. **Part B - the scanned PDF (the case that used to be unsendable).** In
   the same thread, attach `scan.pdf`. Confirm the chip does NOT go red
   and the send button unlocks.
6. Send `Read this document to me.`
7. Confirm the model calls `analyze_pdf_page` (visible as a tool call in
   the transcript) and answers with the scan's actual content.

8. **Part C - visual content in a text PDF.** Attach `chart.pdf` and ask
   `What values does the chart on page 2 show?`
9. Confirm the model calls `analyze_pdf_page` with `page: 2` rather than
   answering from the inlined text.

10. **Part D - the diagnostics that used to lie.** Ask
    `Use analyze_image on text.pdf.` (Direct instruction, to force the
    wrong tool.)
11. Read the tool result in the transcript's detail panel.
12. Ask `What page does that document have that you cannot see?` after
    attaching a PDF longer than 30 pages, if one is handy. Otherwise ask
    the model to call `analyze_pdf_page` on page 999 of `text.pdf`.

13. **Part E - deletion reclaims the pages.** Open the **Artifacts** tab,
    find `text.pdf`, and delete it.
14. Confirm both the rows and the objects are gone:

    ```sql
    select count(*) from message_attachment_pages p
      where p.attachment_id = '<attachment>';
    select count(*) from storage.objects
     where bucket_id = 'attachments' and name like '<uid>/<attachment>/pages/%';
    ```

15. Send another message in the thread and confirm the model no longer
    offers to view that document (the `Viewable pages` line has dropped
    it).

16. **Part F - the GC does not eat live pages.** With `scan.pdf` still
    live, tick the orphan sweep:

    ```sh
    curl -s -X POST "$SUPABASE_URL/functions/v1/attachment-gc" \
      -H "Authorization: Bearer $SERVICE_ROLE_KEY"
    ```

17. Re-check that `scan.pdf`'s page objects are still present and
    `analyze_pdf_page` still works on it.

## Expected

- (1) The chip narrates `Rendering page N of M` as it works, then
  settles to the file size. It never goes red for a valid PDF.
- (3) `page_count` equals the document's true page count;
  `rendered_pages` equals `min(page_count, 30)`. For `text.pdf`,
  `has_text = true`.
- (4) One object per rendered page, zero-padded so they sort in page
  order.
- (5) The chip is ready and send is unlocked. **Before this feature the
  composer blocked here** with "has no extractable text".
- (3, for `scan.pdf`) `has_text = false` (or an empty string) while
  `page_count` is non-null and `rendered_pages > 0`.
- (6-7) A visible `analyze_pdf_page` tool call; the answer reflects text
  that exists ONLY in the scanned image. If the model answers without
  calling the tool, it is fabricating - that's a failure.
- (9) The `analyze_pdf_page` call carries `page: 2` and the answer names
  values that appear only in the chart.
- (11) The `analyze_image` result is an error that says `text.pdf` **is
  in the conversation** but is not an image, names its MIME type, and
  points at both the inlined text and `analyze_pdf_page` with the page
  count. It must NOT say "No image attachment named text.pdf in this
  thread" - that phrasing is the regression this covers.
- (12) An out-of-range page comes back naming the viewable range (e.g.
  `viewable pages are 1-30`), and the model relays that to the user
  rather than guessing at the page's content.
- (14) Both counts are `0` - the Artifacts delete expires the attachment
  row but must hard-delete the page rows and their objects.
- (15) The `<thread_attachments>` block no longer lists the deleted PDF
  under `Viewable pages`; asked about it, the model says the file was
  removed.
- (17) Live page objects survive the sweep untouched. If they vanish,
  `list_orphan_attachment_objects` has lost its
  `message_attachment_pages` anti-join.

## Cleanup

- Delete the QA thread (cascades the attachment and page rows; the next
  `attachment-gc` tick reclaims any objects the inline remove missed).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
