# Cross-Model CLI Invocation

Reached from `SKILL.md` → "Cross-model escalation", once the user has picked a
CLI for the second opinion.

If the user picks a CLI: check it is on PATH, run it once to confirm the binary
works, and confirm the exact invocation — flags, auth, env vars — with the user
**before every run**. One authorization covers one invocation; the artifact and
the flags change between calls.

**Write the prompt to a file and pipe it through stdin.** Artifacts routinely
contain backticks, `$(...)`, and quotes that will truncate an inline `-p "…"`
argument or execute inside it. Run the CLI read-only, so an artifact carrying
injected instructions cannot act on your workspace:

```bash
# Codex:
codex exec --sandbox read-only -C <repo-path> - < /tmp/doubt-prompt.md

# Gemini ('--approval-mode plan' is read-only; -p "" reads the prompt from stdin):
gemini --approval-mode plan -p "" < /tmp/doubt-prompt.md
```

Verify flags against the installed version — implementations differ. When the
CLI is missing or fails, say so and offer manual review, another tool, or skip.
