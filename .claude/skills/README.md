# Vendored Venice API skills

These are Agent Skills for the Venice.ai API, vendored from
[`veniceai/skills`](https://github.com/veniceai/skills) (MIT, see
[`LICENSE`](./LICENSE)). Each `venice-*/SKILL.md` is reference
documentation for one Venice API surface - the wire shape nak talks to.

Claude Code discovers these automatically. Project-level
`.claude/skills/<name>/SKILL.md` is scanned at the start of every
session (local CLI and the web/cloud sandbox alike) - no import into
the web app's Customize / Skills UI is required. Only each skill's
frontmatter `description` is loaded up front; the body loads on demand
when the skill fires, so the per-session context cost is one line per
skill.

## What's here, and what isn't

This is a curated subset, not the full upstream catalog. nak is a chat
frontend over the Venice wire shape, so only the surfaces its request
path exercises are vendored:

- `venice-api-overview` - base URL, auth modes, endpoint map, headers
- `venice-auth` - Bearer key vs x402/wallet auth
- `venice-chat` - `POST /chat/completions` + `venice_parameters`
- `venice-responses` - the Alpha Responses API
- `venice-embeddings` - `POST /embeddings`
- `venice-models` - `GET /models` and capability flags
- `venice-errors` - error shapes + retry strategy (402/422/429)
- `venice-api-keys` - key management + rate-limit introspection
- `venice-billing` - balance + usage

Deliberately excluded (not part of nak's surface): audio (speech,
music, transcription), image generate/edit, video, characters, augment,
crypto-rpc, and x402 wallet payments. Add one later by copying its
folder from upstream if a feature starts using that surface.

## Link rewriting

Upstream `SKILL.md` files cross-link siblings with relative paths
(`../venice-x/SKILL.md`). Links among the vendored subset are left
relative so they resolve in place. Links pointing at an *excluded*
skill are rewritten to absolute upstream URLs
(`https://github.com/veniceai/skills/blob/main/skills/venice-x/SKILL.md`)
so a session that wants an unvendored surface gets sent to the source
instead of hitting a dangling path. The prose is otherwise verbatim.

## Refreshing from upstream

Vendored at upstream commit `de089fac4e2e4a51be2ee701eaec97fd0a60b9d3`.
To refresh: re-copy the curated folders from a fresh clone of
`veniceai/skills`, re-apply the excluded-link rewrite (relative
`../venice-<excluded>/SKILL.md` -> absolute upstream URL for each
excluded surface), and update the commit pin above. If upstream adds a
surface nak has started using, vendor that folder too and move it out
of the excluded list.
