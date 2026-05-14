# Search

Every drawer tab in Nak - Chats, Recipes, Memories, Wiki - has a
search box at the top. They all work the same way: type a query,
wait briefly while Nak embeds your phrase, and the matches come
back in order of closeness rather than alphabetical or
chronological order.

## How matching works

Each search runs in two passes and merges the results:

1. **Meaning match.** Your query is sent to the embedding model
   and compared to a stored vector for every item in that tab.
   The closer the meaning, the higher the rank. This is how
   "fluffy potato side" finds *Mashed Potatoes*.
2. **Word match.** A simple case-insensitive substring search
   over the obvious fields (thread title, recipe title, article
   body). These appear after the meaning matches, so a freshly
   added item that hasn't been embedded yet is still findable -
   just not yet rankable by meaning.

The two passes are deduplicated by id and capped per tab.

## Loading feedback

When you type, Nak debounces briefly (so it isn't embedding every
keystroke), then shows a small scanner animation in place of the
list while the embedding round-trip and the database query run.
The actual results appear once they arrive, replacing the scanner.
Searches typically complete in under a second.

If your network is offline, or the embedding model is briefly
unreachable, Nak falls back to the substring-only pass quietly -
your search will still return matches, just ranked by recency
rather than meaning.

## Ordering

| Tab | Empty query | Active query |
| --- | --- | --- |
| **Chats** | Recent / Older / Archived buckets | Exact title hits first, then by similarity |
| **Recipes** | Most-recent or by rating (your choice) | By similarity to your query |
| **Memories** | Most-recent first | By similarity to your query |
| **Wiki** | Alphabetical by title | By similarity to your query |

The Wiki list switches from alphabetical to relevance order only
while there's text in the search box. Clearing the box returns it
to the alphabetical browse view.

The Recipe list hides its sort picker while you're searching - the
similarity ranking is the sort during a search.

## Why a search might miss something

- The item was just added and the background embedding worker
  hasn't reached it yet. Substring-on-the-obvious-field still
  catches it; meaning matches will catch up within minutes.
- The phrase you typed is too short or too generic for the model
  to anchor on. Try adding a noun or a context word.
- You typed a long query and the substring pass found nothing
  literal; meaning matches still ranked but none were close.

## Where to go next

- [Chats](./threads.md) - the conversation drawer.
- [Recipes](./cookbook.md) - the cookbook drawer.
- [Wiki](./wiki.md) - the wiki drawer.
- [Keyboard shortcuts](./shortcuts.md) - focusing the search box.

---
Back to the [index](./README.md).
