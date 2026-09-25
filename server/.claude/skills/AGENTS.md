# `server/.claude/skills/` — tool scaffolding, currently empty

This directory is where a Claude Code **skill** for this workspace would live: a
folder per skill containing a `SKILL.md` whose frontmatter has a `name` and a
`description`, and whose body holds the instructions.

It is **empty on purpose**. Nothing in the project reads it, no build step touches
it, and no test asserts anything about it. It exists so that an assistant that
looks for a skills directory finds one rather than creating a second convention
somewhere else.

## Why it is documented at all

Because an unexplained empty directory is worse than an absent one: an agent
finding it has to guess whether it is broken, or a leftover, or a place it is
supposed to write to. It is the third.

## What belongs here, if anything

A skill is the right shape for **repeatable, multi-step domain knowledge** that is
too long for a prompt and too specific for a general instruction file. In this
repository, the candidates would be:

* "add a milestone's read API end to end" (migration, service, serializer,
  controller, route, `openapi.yaml`, tests, docs);
* "add a SQL constraint and mirror it into `prisma/schema.prisma`";
* "write an integration suite for a new endpoint, including its ownership cases".

Note that the same knowledge already lives in `AGENTS.md` at four levels — the
repository root, `server/`, and each source folder — plus `README.md`, one section
per milestone. **Prefer extending those**: they are read by every assistant and by
people, while a skill is read only by one tool.

## Sibling convention

`../../../.windsurf/skills/` is the equivalent for another editor's tooling and is
also empty. See `../../AGENTS.md` for what the server itself contains.

## Depends on / depended on by

Depends on nothing and is depended on by nothing. Deleting it would change no
behaviour; keeping it is a small courtesy to the next tool that looks for it.
