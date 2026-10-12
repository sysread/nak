# Image editing

Nak can now **change pictures it already has** - photos you attached to
a chat and pictures Nak drew for you earlier - instead of only creating
new ones. Three things you can ask for in plain words:

- **Edit it.** "Make the sky a sunset." "Remove the tree behind the
  car." "Turn the cube blue." Small, specific instructions work best;
  Nak chains them, so you can keep going ("now add a bird").
- **Upscale it.** "Make this 2x bigger." Useful for small or soft
  images. Very large sources can refuse a big upscale - the result
  would not fit in storage - and Nak will tell you what fits.
- **Cut the subject out.** "Remove the background" gives you a
  transparent PNG sticker of the subject.

Each result appears right under the tool call in the chat, and the
**original picture is never changed** - every edit creates a new
image. Edited images are regular attachments: they live with the
conversation, appear in the Artifacts tab, and are deleted when you
delete them there.

## Which pictures qualify

Anything already in the conversation: a photo you attached, an image
Nak generated, or the output of a previous edit. If the picture is in
the thread, just refer to it naturally ("the second photo"). Nak
cannot edit pictures it has never seen in that conversation, and it
will look at a picture first (analyze it) when it needs to know what
it shows before changing it.

## Picking the edit model

Settings -> AI -> **Image editing** picks the model Nak uses for
edits. Each row shows the **per-edit price** from the live catalog
and a **privacy badge**:

- the **lock** means Private - the picture and your instruction stay
  on Venice's own infrastructure;
- the **mask** means Anonymized - the request is forwarded to a third
  party (with identifying details stripped), which is faster or
  prettier but sends the image off Venice's platform.

If your plan has a per-image price cap, models over the cap are
hidden from the list. Picking the default (FireRed Image Edit)
clears the override so "default" stays meaningful.

## Good to know

- **Edit before upscaling.** An upscaled image can be too large to
  edit afterward, so make content changes first and enlarge last.
- **Costs are per operation**, like image generation. The price shown
  in the picker is what an edit costs; upscales bill at a higher rate
  above 2x.
- **Content policy still applies** - a request Venice's policy rejects
  comes back as a polite refusal from Nak, not a broken image.
- **Deleted means gone.** Deleting an attachment (Artifacts tab)
  removes the bytes; Nak can no longer see or edit it, and the
  conversation keeps only the mention.
