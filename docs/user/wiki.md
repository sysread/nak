# Wiki

The Wiki is a flat encyclopedia **about you** - your projects, the
people in your life, places you live or care about, things you're
learning or reading, work, hobbies, experiments. Every entry is a
titled article in encyclopedic third-person prose. There's no
nesting; everything sits at the same level and the drawer lists
articles alphabetically.

The wiki is a peer to Memory and Journal. Memories are atomic facts
the assistant references inline. Journal entries are dated reflections
about how a conversation went. Wiki articles are the longer-form
topical pages that cover what something IS - "the recipe project",
"Maya", "Lisbon trip planning". An article sits across many
conversations.

## Scope: about you, not about the world

The wiki is deliberately user-centric. Articles describe things in
your life. They do **not** describe generic topics that came up in
conversation. So:

**In scope** - article-worthy when discussed:

- Projects you are building, planning, or running.
- People in your life - family, friends, colleagues, contacts.
- Places you live, work, travel to, or care about.
- Things you are learning or reading - books, courses, papers,
  skills you are practising.
- Habits and experiments you are tracking - a running streak,
  a sourdough starter, an elimination diet.
- Your career, current job, prior roles, ongoing work.
- Hobbies and interests you have invested time in.

**Out of scope** - even if the conversation discussed them at length:

- General technical concepts, libraries, protocols, or frameworks
  not specific to one of your projects.
- World-knowledge topics: historical events, scientific concepts,
  geography.
- Public people you don't know personally - celebrities, authors of
  books you're reading, historical figures.
- News, current events.
- Tutorials and one-off help interactions.

When an external topic gets mentioned inside a user-centric article
(say, you're building an app whose name references a 1980s
file-transfer protocol), the agent will add a Markdown link to a
public source like Wikipedia rather than creating a separate
article. External topics are linked, never given their own pages.

Both the per-conversation agent and the librarian enforce this
scope. The librarian will delete out-of-scope articles it finds on
its periodic sweep, so any encyclopedic-but-not-about-you articles
that slipped through earlier should disappear over the next 12 to
24 hours.

## Opening the Wiki

Click the **Wiki** tab in the left drawer. The sidebar shows the
alphabetical listing with a search bar at the top; the main panel
opens whichever article you click.

When the Wiki tab is open with no article selected, the panel shows
an empty-state hint plus an "add a new one" link that opens the
inline create form.

## What goes in an article

Articles are encyclopedic - they read like Wikipedia lead paragraphs,
not chat replies. Third person, present tense, neutral. They're meant
to summarize what you'd want to come back to later, not transcribe a
conversation.

Each article has just two fields:

- **Title** - the topic name. This is the alphabetical sort key in
  the drawer and must be unique. The title cap is 200 characters.
- **Content** - the article body, in Markdown. Capped at 16,000
  characters.

## Searching

The search bar above the listing filters the drawer in place. It uses
the same semantic-search pipeline the assistant uses for `wiki_search`
(see "How the assistant uses the wiki" below) - typing a phrase finds
articles by meaning, not just by literal substring. Substring matches
are merged in too, so an article you wrote ten seconds ago (before the
embedding worker has caught up) still surfaces.

Clearing the search returns the alphabetical listing.

## Adding an article

Click the empty-state link **add a new one**, or click **Wiki** in the
drawer with no article selected. The inline form takes a title and
content; **Save** persists immediately and surfaces the new article in
the panel.

Titles are unique per user. If you try to create an article with a
title that already exists you get a clear error and can either rename
the new draft or open the existing article and edit it.

## Editing

Open an article and click **Edit**. The view flips to a form with the
title and content fields. The form shows "Unsaved changes" the moment
you diverge from the stored row; **Save** persists, **Cancel** drops
the draft.

Saving an article nulls its embedding - the background embedding
worker will re-compute on its next poll (within ~30 seconds). Search
falls back to substring matches in the meantime.

## Deleting

Click **Delete** on the open article. A confirmation strip appears -
**Delete** is the destructive action, **Cancel** dismisses the prompt.

Deletes are hard - the article doesn't move to a trash bin. If you
delete by mistake the easy recovery is to ask the assistant to
reconstruct it from the relevant conversations and call `wiki_create`,
or to recreate it manually.

## Asking the agent to update an article

Each article has an **Ask agent to update** button that opens an
instructions textarea. Type what you want the agent to do ("add a
sentence noting that Maya prefers green tea", "fix the date in
paragraph two", "rewrite the second paragraph for tone but keep the
facts") and click **Ask agent**.

The agent runs on the spot and shows a preview. You then have three
choices:

- **Accept** - persist the agent's version. The article updates and
  the listing reflects the change.
- **Try again** - throw away the preview and run the agent again.
  Useful if the agent's interpretation didn't quite match what you
  wanted.
- **Cancel** - close the preview without changing anything.

The agent is told to do exactly what you ask AND to preserve every
fact already in the article unless you explicitly say to remove or
replace it. So "add a sentence" adds without rewriting; "rewrite the
second paragraph" rewrites only that paragraph; "fix the date in
paragraph 2" patches that single value.

If your instructions don't actually require a change ("looks fine",
"no edits"), or are too ambiguous to act on without the agent
inventing facts, the agent emits a "no change applied" note with its
reasoning instead of a preview. You can Try Again with sharper
instructions or close the dialog.

## The autonomous background agent

A background agent reads conversations a day after they settle and
either updates an existing article or creates a new one. The
specifics:

- A conversation becomes eligible the day **after** its newest
  message lands (in your timezone). A conversation that wraps Monday
  evening is eligible Tuesday morning.
- If you continue the conversation, it becomes eligible again the day
  after that. So Monday -> agent runs Tuesday -> you continue
  Wednesday -> agent runs again Thursday on the new turns.
- The agent decides per topic whether to update, create, or do
  nothing. The bar for creating an article is "would the user later
  look this up?", not "did this come up at all?".
- When updating an existing article, the agent preserves every fact
  unless the conversation directly contradicts it. The wiki accretes
  rather than churns.

You can disable the autonomous agent in **Settings -> Wiki**. Manual
edits and the per-article "Ask agent to update" flow keep working
when it's off.

## The librarian

A second background agent - the wiki **librarian** - runs every 12
hours or so. Its job is different from the per-conversation agent:
instead of reading a single conversation and adding to the wiki, the
librarian looks at the wiki as a whole and tries to make it more
coherent. It can:

- **Consolidate near-duplicates.** When two articles cover the same
  subject under slightly different titles, the librarian merges the
  unique facts from one into the other and deletes the redundant
  one.
- **Fact-check against conversation history.** When an article makes
  a specific claim that might be stale - a job title, a relationship
  status, a project status - the librarian searches your past
  conversations for evidence and updates the article when it finds a
  clear contradiction.
- **Tighten subject boundaries.** When two articles bleed into each
  other (a "Maya" article and a "household" article both covering
  the same person), the librarian rewrites both so the split is
  cleaner.

The librarian is intentionally constrained: it cannot create new
articles, only consolidate or update existing ones. New articles
flow from the per-conversation agent or from your direct edits. And
it's conservative - if it isn't confident two articles overlap
enough to merge, it leaves them alone.

The 12-hour minimum interval is enforced atomically across devices
(via a Postgres claim); only one run happens per cycle even if you
have the app open on multiple devices.

You can disable the librarian independently from the per-conversation
agent in **Settings -> Wiki**. The two toggles are independent: you
can run one without the other.

## How the assistant uses the wiki

Articles are **never** auto-injected into the chat. The assistant
reaches them only through `wiki_search`, an always-on tool registered
on every conversation. When you mention something topical or factual
about yourself - a project, a person, a place, a habit - the
assistant will call `wiki_search` to pull the relevant article so its
reply is grounded rather than guessing.

This is the deliberate split between the three knowledge surfaces:

- **Memory** - atomic facts, may be primed inline at the start of a
  conversation.
- **Journal** - dated reflections; today's automatic entry is included
  in the system prompt on the first turn.
- **Wiki** - encyclopedic articles, never auto-included. Always
  retrieved on demand.

If you want the assistant to use a particular article, mention the
topic (or the title) directly - that's the cue for `wiki_search`.

## Settings controls

The **Settings -> Wiki** pane has two independent toggles:

- **Automatic articles** - whether the per-conversation wiki agent
  runs in the background after threads settle.
- **Librarian** - whether the periodic librarian agent runs in the
  background to consolidate and fact-check.

Both are on by default. The wiki uses the same day boundary timezone
you set on the Journal pane.
