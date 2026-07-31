# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when
the document is a skill — frontmatter, the invocation choice, and router skills.
Everything else about writing it is the universal reference in `SKILL.md`.

> Adapted from [mattpocock/skills — writing-for-agents/SKILL-MECHANICS.md](https://github.com/mattpocock/skills/blob/fa3b2a6b355cf77ee0f2fb8c347f62ec42bbf022/skills/productivity/writing-for-agents/SKILL-MECHANICS.md) (v1.2).

## Frontmatter

A skill is `skills/<name>/SKILL.md` with a YAML header carrying `name` (matching
the directory) and `description`. The hosts read that header: OpenCode and
Claude Code both surface every skill under `skills/` through the same directory,
so the header is written once and loaded by all of them.

## Invocation

Two choices, trading the two loads:

- A **model-invoked** skill keeps a `description`, so the agent can fire it
  autonomously — and other skills can reach it. You can still type its name:
  model-invocation always _includes_ user reach; a description only ever adds
  agent discovery, never removes the human's. The description is the skill's
  top-level context pointer, forced to stay loaded at all times — permanent
  context load in exchange for discoverability. A model-invoked skill whose
  content is all reference is also one home for shared reference: another skill
  can invoke it, so reference needed by several skills lives in one place.
  Mechanics: omit `disable-model-invocation`, and write a model-facing
  description carrying the trigger branches (the pointer-writing rules in
  `SKILL.md` apply in full). **Every skill in this repository is
  model-invoked** — `using-agent-skills` is the routing map that keeps those
  descriptions from overlapping.
- A **user-invoked** skill strips the description from the agent's reach: only
  the human typing its name can invoke it, and no other skill can. Zero context
  load, but it spends cognitive load — you are the index that must remember it
  exists. Mechanics: set `disable-model-invocation: true`; the `description`
  becomes human-facing — a one-line summary, trigger lists stripped. **Unused
  here today**; it is the pole the invocation trade-off is measured against, and
  the mode to reach for if a host ever consumes it.

Pick model-invocation only when the agent must reach the skill on its own, or
another skill must. If it only ever fires by hand, make it user-invoked and pay
no context load.

Shared reference that two user-invoked skills both need can live in neither —
with no descriptions, neither can fire the other. Push it to a plain file
outside the skill system: external reference any skill can point at (in this
repository, `references/*.md`).

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split
off a model-invoked skill when you have a distinct leading word that should
trigger it on its own — a trigger word you actually use in your prompts — or
another skill must reach it. You pay context load for the new always-loaded
description, so that independent reach has to be worth it.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up
cognitive load is cured by a **router skill**: one user-invoked skill that names
the others and when to reach for each, so the human has one skill to remember
instead of many. It can only hint, never fire them: user-invoked skills have no
description, so nothing but the human can reach them. In this all-model-invoked
library, `using-agent-skills` plays the model-invoked analogue — one routing map
instead of many overlapping descriptions.
