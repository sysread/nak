# Plan Completion (Mꭥ)

Use when finishing planned work - work tracked by a plan file in
`docs/dev/in-progress/`. This is the final milestone before merging:
update the docs and use cases to reflect what shipped, then retire the
plan file.

## When to use

- The code changes are complete and the gate is green.
- A plan file exists in `docs/dev/in-progress/`.
- The branch is about to merge to main.

Do NOT use mid-project. This skill runs once, at the end.

## Steps

### 1. Graduate the plan doc

Read the plan file in `docs/dev/in-progress/`. Decide where the
durable content belongs:

- **New permanent dev doc**: if the feature introduces a new
  subsystem, create `docs/dev/<feature>.md` following the
  per-feature doc pattern (Role, Files, Entry points, Data model,
  Contracts, Interactions, Gotchas). Move the "how it works now" end
  state and load-bearing design rationale from the plan file.
- **Update existing dev docs**: if the feature modifies an existing
  subsystem, update the relevant sections of its doc. Check the
  Interactions ledgers of coupled features - the plan file's
  Interactions section names them.
- **Update `docs/dev/README.md`** index if a new doc was added.
- **Update `docs/dev/architecture.md`** if the feature introduces a
  new subsystem pattern or changes the production-path ownership
  table.

### 2. Retire the in-progress doc

Delete the plan file from `docs/dev/in-progress/`. Git preserves the
narrative. Fix any inbound links (grep `in-progress/` across
`docs/`).

### 3. Update user docs

Per the CLAUDE.md hard rule: "any change to observable user behavior
must update `docs/user/` in the same PR." Check:

- New UI controls, settings, shortcuts, flows, renamed menu items,
  user-visible copy.
- Update the relevant `docs/user/` page(s).
- Ensure the landing page (`docs/user/README.md`) links to any new
  pages.

### 4. Audit QA use cases

Review every use case in `docs/qa/use-cases/`:

- **Stale use cases**: if a use case documents behavior that the
  project changed, update it. BUT first verify the code drift was
  intentional (not a bug) by checking git history. Updating a use
  case to match buggy behavior creates a testing gap.
- **Drifted use cases**: if you notice a use case that has drifted
  from the code for reasons unrelated to this project, flag it to the
  user. Do not update it without confirming the drift is intentional.
- **New use cases**: if the project introduces new behaviors or
  features, add use cases to cover them. Use the format in
  `docs/qa/README.md` (Covers, Preconditions, Steps, Expected,
  Cleanup, Results log).
- **Update `docs/qa/README.md`** index if new use cases were added.

### 5. Update the spike doc (if applicable)

If the project created a spike doc in `docs/dev/in-progress/` for
related future work, check whether it needs updates based on what
shipped. The spike doc captures findings that may have shifted during
implementation.

### 6. Verify

- Run `mise run check` (includes markdownlint over the doc tree).
- Grep for any remaining `in-progress/` links that dangle.
- Confirm the in-progress directory only contains genuinely open
  work.
