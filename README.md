# whippletree

A starting point for a new project that agents (Claude Code, Cursor, Codex, Copilot, Gemini) help build.
It gives you:

- agent rules that every tool reads the same way (`AGENTS.md`, `.cursor/rules/`)
- hooks and git guards that stop the irreversible commands (merge, force-push, delete data)
- a branch flow (`dev` → `main`), draft PRs, and CI that spends minutes on purpose
- plans, roles (showrunner, wrangler, farrier …), and repo memory (decisions, learnings, deferred work)
- stack packs you keep or remove: TypeScript, React, Rust, Python, Go, Swift, Kotlin, C++, infra (Terraform and Docker), SQL migrations

It is for people who want agents doing real work under rules that **fail loud** instead of rules an agent has to remember.

## Opinionated, provided as is

- This is one person's opinionated setup, shared because it works for them. It is not a framework with a roadmap.
- It is not a support channel. Fork it, change the rules, make it yours.
- Issues and pull requests may sit unanswered. If you want a change, expect to carry it in your own copy.
- No warranty. The guards lower the odds of a bad command, not to zero. Read what an agent is about to do.

## Quickstart

1. **Use this template** on GitHub (the green button on the repo page), private is fine. Clone your new repo.
2. `pnpm install` (needs Node 24 and pnpm; [prerequisites](docs/guide/getting-started.md#prerequisites)), then `pnpm hooks:install`.
3. Keep what you use: `pnpm stack:list`, then `pnpm stack:remove <pack>` for the rest, as a PR into `dev` ([choose your stacks](docs/guide/getting-started.md#2-choose-your-stacks)). Before bootstrap, so its rulesets require only your packs' checks.
4. `bash scripts/bootstrap-repo.sh` once: creates `main`, the branch rulesets, the git hooks, and the harness base (needs an authenticated `gh` with admin on the repo).
5. `pnpm check` is green? You are ready for your first plan and first PR: [getting started](docs/guide/getting-started.md).

```bash
pnpm stack:list
```

<!-- doc-run: skip needs a GitHub login and a repo you own -->
```bash
bash scripts/bootstrap-repo.sh
```

## The guide

Everything else is in [`docs/guide/`](docs/guide/):

- [getting-started](docs/guide/getting-started.md) — prerequisites, bootstrap, placeholders, stacks, first plan, first PR
- [concepts](docs/guide/concepts.md) — harness vs project files, the branch flow, who clicks what, repo memory
- [agents](docs/guide/agents.md) — setup per tool, and what is verified vs assumed
- [models](docs/guide/models.md) — Claude at home, ChatGPT as rival, Grok as wildcard: setup, which model runs each tier, finding model ids
- [roles](docs/guide/roles.md) — showrunner, wrangler, farrier, dynamite-test, command-guard, ship, compound, with start prompts
- [keeping-in-step](docs/guide/keeping-in-step.md) — pull and push harness updates, project overrides, stacks
- [troubleshooting](docs/guide/troubleshooting.md) — a guard refused a command, a red drift run, a slow hook
- [repo-map](docs/guide/repo-map.md) — what every file and folder is for, and who owns it

## Principles (short)

- **One canonical copy.** Rules live in `.cursor/rules/`; everything else is generated or points there.
- **Humans own the irreversible.** Agents open draft PRs. You click Ready, merge, ship, and run anything that deletes data.
- **Enforce, don't remind.** Boundaries, types, and human-only commands are checks and hooks.
- **Small and plain.** Before writing code, ask whether it needs to exist.
- **Decisions outlive conversations.** Deferrals, decisions, learnings, and plans are files in `docs/`.
