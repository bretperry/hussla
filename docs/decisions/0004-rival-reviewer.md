# 0004. The rival model reviews through OpenAI's Codex plugin, scoped by one project setting

`accepted` · 2026-10-04 · from the "ChatGPT as rival reviewer" project thread

## Context

- `plans.mdc` → Model tiers already had a `rival` lineage (OpenAI) "for a second opinion", but nothing ran it.
- Claude reviewing Claude's code shares Claude's blind spots; a second model family catches a different set.
- Codex CLI 0.149.1 deprecated `codex mcp-server`; OpenAI's supported bridge is the Codex plugin for Claude Code (`openai/codex-plugin-cc`). Its `/codex:adversarial-review` is user-invoked only, so an agent can't call it as a command.
- Reviews cost the user's OpenAI quota and send code to a second provider, so how often it runs has to be a project choice.

## Decision

- The rival runs when the project picks a `deep` → `rival` model (see 0005); no pick turns it off. Its model id is passed to Codex.
- `dynamite-test.project.json` → `scope` picks when the dynamite test (formerly adversarial review) runs at all: `all`, `high-risk` (default), or `major-release`. Each is a superset of the next; `dynamite-test.mdc` → When it runs defines them. `rivalScope` takes the same values for the rival alone, follows `scope`, and may only be narrower, for a project whose OpenAI budget is smaller than its Claude one.
- `scripts/rival-review.mjs` (`pnpm rival`) is the one entry point: it calls the plugin's runtime when installed and falls back to `codex exec --sandbox read-only`, so Cursor and Gemini CLI get the same rival. Review and chat are always read-only.
- Disagreements between `home` and the rival are argued with the rival (`pnpm rival chat`, at most two rounds), then go to the user.
- Signing in is the user's step; no key is stored in the repo.

## Consequences

- Risky changes get a cross-family review with no new API code to maintain; the plugin owns prompts and output schema.
- The script depends on the plugin's cache path and companion CLI; a plugin change can break the fast path, and the CLI fallback still works. `pnpm rival doctor` shows which path is live.
- Revisit if the plugin exposes a model-invocable review, or if Codex ships a stable MCP or app-server API an agent can call directly.
