# Agent setup

One rule set, five tools. What each reads, what to do once, and what has actually been tested.

**Verified** = exercised in this repo (tests, or a real session). **Assumed** = follows from the tool's documented behavior; nobody has run it against this repo yet. If you find an assumption wrong, fix this page.

## What protects you, by tool

| Layer | Claude Code | Cursor | Codex | Copilot | Gemini CLI |
|---|---|---|---|---|---|
| Reads the rules (`AGENTS.md`) | Verified (via `CLAUDE.md`) | Assumed | Assumed | Assumed | Assumed (via `.gemini/settings.json`) |
| Command guard (refuses human-only commands) | Verified | Wired, not verified | Not wired | Not wired | Not wired |
| Edit check (typecheck, lint, boundaries after each edit) | Verified | Wired, not verified | Not wired | Not wired | Not wired |
| Skills / roles (`showrunner` and friends) | Verified | Assumed | Not wired | Not wired | Not wired |

"Verified" for the guard and edit check means `scripts/command-guard.test.mjs` and the pack edit-check tests drive them with Claude Code's input shape, and they were built in Claude Code sessions.

Two layers do not depend on the tool: the **git pre-push hook** and the **GitHub rulesets**. They act on whatever pushed. The hook is plain git behavior but has no automated test here, and the rulesets are created by `bootstrap-repo.sh` and only as strong as your plan allows (see [getting started](getting-started.md#prerequisites)). For a tool with no hooks they are the backstop. Tell that tool's agent to read the rules index in `AGENTS.md`, and treat "never run these commands" in `core.mdc` and `branching.mdc` as yours to watch.

## Claude Code

- **Reads:** `CLAUDE.md` (which imports `AGENTS.md`), `.claude/rules/*.md` (generated), `.claude/skills/*`, `.claude/settings.json`, `.mcp.json`.
- **Hooks** (in `.claude/settings.json`): `scripts/command-guard.mjs` before every Bash command (through `scripts/command-guard-hook.mjs`, which blocks when the guard can't load); `scripts/check-edited.mjs` after every Edit or Write. Both need only Node, so they run before `pnpm install`.
- **Do once:** open the repo in Claude Code and approve the project's plugins when asked.
<!-- [stack:typescript] -->
- **TypeScript language server:** `.claude/settings.json` enables the `typescript-lsp` plugin (setup below).
<!-- [/stack:typescript] -->
<!-- [stack:go] -->
- **Go language server:** `.claude/settings.json` enables the `gopls-lsp` plugin; it needs `gopls` on PATH.
<!-- [/stack:go] -->
- **Permissions:** the allow list in `.claude/settings.json` covers the read-only and check commands (`pnpm check`, `pnpm test`, `gh pr view` …). Anything not on it prompts you, which is intended.
- **Roles:** say the name. `help` prints a one-screen card; `setup` walks you through setup by asking; `showrunner`, `wrangler`, `farrier`, `dynamite-test`, `ship`, `compound`, and `plan-board` load their rule on demand. Start prompts are in [roles](roles.md).
- **The guard is off in some environments.** A cloud or sandboxed session may not run project hooks. Check by asking the agent to attempt a command the guard refuses (see [troubleshooting](troubleshooting.md#is-the-guard-even-running)).

<!-- [stack:typescript] -->
TypeScript 7 ships no `tsserver`, so Claude Code's `typescript-lsp` plugin needs TypeScript 6 installed globally:

<!-- doc-run: skip installs global packages -->
```bash
npm i -g typescript-language-server typescript@6
```

Without it the plugin does nothing; the checks still run.
<!-- [/stack:typescript] -->

## Cursor

- **Reads:** `.cursor/rules/*.mdc` natively, each scoped by its `globs`; `AGENTS.md`; `.claude/skills/` (Assumed); `.cursor/mcp.json`.
- **Hooks** (`.cursor/hooks.json`): the same two scripts, in Cursor's `beforeShellExecution` and `postToolUse` shapes. Follows Cursor's documented format, but Cursor's docs do not name the field its Write tool uses for the path, so the edit hook reads `file_path` or `path` and stays silent otherwise. It has not been run inside Cursor (`docs/deferred.md`).
- **To verify yours:** ask the agent to run a command the guard should stop, and to introduce a type error. Expect a refusal and a reported error.

## Codex, Copilot, Gemini CLI

- **Read:** `AGENTS.md`. Gemini is pointed at it by `.gemini/settings.json` (`context.fileName`).
- **Rules that are not always-on** live in `.cursor/rules/*.mdc` and are indexed in `AGENTS.md`. Those tools do not auto-load them; tell the agent to read the matching file before touching that area (`AGENTS.md` says so).
- **No hooks are wired for them.** They rely on the git hook and rulesets, and on following `AGENTS.md`.
- **Roles:** the same `.mdc` files work as plain instructions. Paste a start prompt from [roles](roles.md) and add "read `.cursor/rules/<role>.mdc` first".

## MCP servers

`.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor) ship empty. Prefer a CLI when one exists (`gh`, `ast-grep`): it costs less context than a server. Do not add or remove servers or plugins mid-task; either throws away the prompt cache.

## Rules for adding your own

Add rules in `.cursor/rules/`, and keep the three always-on ones (`core`, `architecture`, `branching`) short, since every tool loads them. Project additions to a harness rule go in `<rule>.project.mdc`. After any rule edit run `pnpm rules:sync`. The authoring details are `rule-authoring.mdc`.
