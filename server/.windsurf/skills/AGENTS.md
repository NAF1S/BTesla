# `server/.windsurf/skills/` — tool scaffolding, currently empty

The Windsurf (Cascade) equivalent of `server/.claude/skills/`: a folder per skill,
each with a `SKILL.md` describing when to use it and what to do.

It is **empty on purpose**, and nothing in the project reads it — no build step, no
test, no runtime code.

## Why it is documented at all

An empty directory with a suggestive name invites an assistant to guess: is it
broken, is it a leftover, or is it where I should write? It is where you *may*
write, and it is fine that it is empty.

## What belongs here, if anything

Only knowledge that is genuinely **skill-shaped**: a repeatable, multi-step
procedure specific to this workspace. The plausible ones are the same as the
sibling directory's:

* adding a read endpoint end to end (migration → service → serializer →
  controller → route → `openapi.yaml` → tests → docs);
* adding a constraint in `server/db/*.sql` and mirroring it into
  `prisma/schema.prisma`;
* writing an integration suite that covers ownership as well as the happy path.

**The project's own documentation comes first.** `AGENTS.md` exists at the
repository root, in `server/`, and in each source folder; `README.md` explains one
milestone per section; `server/openapi.yaml` is the machine-readable contract. A
skill that duplicated any of those would drift from it, and a drifting skill is
worse than none because it is believed.

## Sibling convention

`../../.claude/skills/` is the same idea for another tool and is also empty. See
`../../AGENTS.md` for what the server actually contains.

## Depends on / depended on by

Depends on nothing; depended on by nothing. Remove it freely — it holds no
behaviour and no data.
