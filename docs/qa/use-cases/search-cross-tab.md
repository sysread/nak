# Search: shared drawer behavior across tabs

## Covers

The shared semantic/substring search pipeline
([dev: conversation-recall](../../dev/conversation-recall.md),
[dev: memory](../../dev/memory.md), [dev: wiki](../../dev/wiki.md),
[dev: cookbook](../../dev/cookbook.md)), scanner loading state, and
tab-specific result ordering / browse fallback.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- At least one searchable item in each relevant tab:
  - a thread with a distinctive title or summary,
  - a recipe,
  - a memory,
  - a wiki article.
- If needed, seed unique test strings in those records before starting.

## Steps

1. In the Chats drawer, search for a distinctive known term.
2. Clear the search box.
3. In the Recipes drawer/tab, search for a recipe-specific term.
4. Clear the search box.
5. In the Memories tab, search for a memory-specific term.
6. Clear the search box.
7. In the Wiki tab, search for an article-specific term.
8. Clear the search box.
9. In any tab, search for a fresh literal string that exists in the item
   body/title but is likely not yet semantically embedded.

## Expected

- (1, 3, 5, 7) Typing a query replaces the browse list with the shared
  scanner/loading state before results render.
- (1) Chats search returns relevant threads in search ordering rather than
  the normal recency browse order.
- (2) Clearing the Chats query restores the normal browse list.
- (3) Recipes search returns relevant recipes and hides the sort picker
  while the query is active.
- (4) Clearing the Recipes query restores the normal recipe browse / sort
  controls.
- (5-6) Memories search returns matching memories, and clearing the query
  restores normal memory browsing.
- (7) Wiki search switches from alphabetical browse to relevance ordering
  while the query is active.
- (8) Clearing the Wiki query restores the alphabetical article list.
- (9) The literal string is still found via substring fallback even when
  semantic ranking has not caught up yet.

## Cleanup

- Clear any active search query before leaving each tab.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
