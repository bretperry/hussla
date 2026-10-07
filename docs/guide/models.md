# Models: Claude at home, ChatGPT as rival, Grok as wildcard

How whippletree picks AI models, how to set up each one, and how to find the exact model ids. Do the steps in order; only step 1 is required.

## The idea in one minute

- **Plans name a tier, never a model.** Each phase says `quick`, `workhorse`, `deep`, or `frontier` (plus a thinking level). Model names go out of date every few months; tiers don't.
- **Each tier has a model per lineage.** A lineage is a model family and the tool that runs it:

  | Lineage | Vendor | Tool | Job |
  |---|---|---|---|
  | `home` | Anthropic (Claude) | Claude Code | Does the work: plans, code, reviews. Required. |
  | `rival` | OpenAI (ChatGPT) | Codex CLI | Second opinion in the dynamite test of risky changes. Optional. |
  | `wildcard` | xAI (Grok) | Grok CLI | A third voice, only when a plan asks for it (`· wildcard`). Optional. |

- **Whippletree suggests a model for every cell** (`model-tiers.json`). Your team can override any cell, and so can you for yourself ([overrides](overrides.md)).
- **See what your project runs:**

```bash
pnpm models
```

Cells marked `*` are your team's picks, `**` your own; the rest are whippletree's suggestions. `—` means no pick.

## 1. Claude Code (home, required)

1. **Install.** macOS, Linux, or WSL:

<!-- doc-run: skip installs software system-wide -->
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

   Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`. Homebrew: `brew install --cask claude-code`. Then open a new terminal and check `claude --version`.
2. **Sign in.** Run `claude` in your repo and follow the browser prompt. You need a Claude Pro, Max, Team, or Enterprise plan, or a Console (API) account; the free plan doesn't include Claude Code.
3. **Trust the project settings.** On first open Claude Code asks to trust the folder and offers the plugins in `.claude/settings.json` (language servers, and the `openai-codex` marketplace for step 2). Accept.
4. **Check the model.** `/status` shows the model running now, by full id.

How home picks a model: the session you talk to runs whatever you choose (`/model opus`, `claude --model sonnet`). Workers the showrunner starts run the tier's model from `pnpm models get <tier> home`. The aliases `haiku`, `sonnet`, `opus`, and `fable` always mean the newest of that family; set a cell to `latest` to follow them.

## 2. ChatGPT through Codex (rival, optional)

With a rival picked for `deep` (the template picks one), ChatGPT reviews risky changes too, and Claude argues disagreements out with it before you see them. What it reviews is `dynamiteTest.rivalScope` in [your overrides](overrides.md): `all`, `high-risk`, or `major-release`, following the dynamite test's own `scope` (default `high-risk`) unless you set it. On a small ChatGPT budget, set `"rivalScope": "major-release"` so it only reviews major ships ([dynamite-test.mdc](../../.cursor/rules/dynamite-test.mdc) → Rival).

1. **Install the Codex CLI and sign in.** A ChatGPT plan works, Free included. To use an API key instead, pipe it to `codex login --with-api-key`; never put it in the repo.

<!-- doc-run: skip installs a global package and signs in to OpenAI -->
```bash
npm install -g @openai/codex
codex login
```

2. **Claude Code:** accept the `openai-codex` marketplace when asked (step 1.3). Or add it yourself: `/plugin marketplace add openai/codex-plugin-cc`, `/plugin install codex@openai-codex`, `/reload-plugins`. **Cursor, a plain shell:** nothing more; `pnpm rival` uses the CLI.
3. **Check.** It names each missing piece, checks that Codex knows the picked model id, and exits 1 until all is well.

<!-- doc-run: skip needs the Codex CLI and an OpenAI sign-in -->
```bash
pnpm rival doctor
```

**Use it yourself:** `pnpm rival review` (this branch against `origin/dev`), `pnpm rival chat "is this migration safe to run twice?"`, then `pnpm rival chat --resume "…"` to keep the thread. In Claude Code, `/codex:adversarial-review` and `/codex:status` work too.

**Turn it off:** set `deep` → `rival` to `none` under `models` (section 5): in `agent-overrides.json` for the team, or your own `agent-overrides.local.json` if only you have no Codex account.

## 3. Grok (wildcard, optional)

Nothing calls the wildcard on its own; a plan opts a phase in with `· wildcard` in its Model cell, for a tie-break between home and rival.

1. **Install and sign in.** macOS or Linux (Windows: `irm https://x.ai/cli/install.ps1 | iex`):

<!-- doc-run: skip installs software and signs in to xAI -->
```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok
```

   The first launch signs you in through the browser. An xAI API key in `XAI_API_KEY` works instead; keep it in your shell profile, never in the repo.
2. **Check the model ids** (section 4) with `/model` inside `grok`: the suggested Grok ids came from xAI's docs and haven't been checked against the CLI yet.

## 4. Find the model ids

Every vendor names models two ways: a label people say ("Opus 5.5") and an id the tool takes (`claude-opus-5-5`). Cells in your overrides take the **id**. Whippletree keeps a list of every model each vendor offers, with the tier it suggests for each:

```bash
pnpm models catalog
```

Add a vendor name for one list: `anthropic`, `openai`, `xai`, `google`, `github-copilot`. Tiers in the list: `quick` (fast, cheap), `workhorse` (most building), `deep` (risky work, review), `frontier` (hardest reasoning), `legacy` (superseded; still works), `special` (not for plans: security-tuned, previews, a tool's internal reviewer).

The list is a snapshot. To see what your own account can use today, ask the tool:

| Vendor | Ask the tool | Docs |
|---|---|---|
| Anthropic | `/model` in `claude` (aliases), `/status` (the full id running now) | [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) |
| OpenAI | `codex debug models` (full catalog as JSON; works signed out), or `/model` in `codex` | — |
| xAI | `/model` in `grok`, or `grok inspect` | [Models](https://docs.x.ai/docs/models) |
| Google | `/model` in `gemini` | [Models](https://ai.google.dev/gemini-api/docs/models) |
| GitHub Copilot | `/model` in `copilot` (after `copilot login`) | [Supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models) |

Just the OpenAI ids, one per line:

<!-- doc-run: skip needs the Codex CLI -->
```bash
codex debug models | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).models.forEach(m=>console.log(m.slug,"·",m.display_name)))'
```

**GitHub Copilot** sells many vendors' models under one GitHub plan, with its own ids (`claude-haiku-4.5`, `gpt-5.4`: dots where Anthropic uses dashes). Its list is in the catalog for reference; whippletree's lineages run each vendor's own tool, so a Copilot id won't work in a home, rival, or wildcard cell.

## 5. Choose your own

Set cells under `models` in `agent-overrides.json` (the team's) or `agent-overrides.local.json` (yours, gitignored; `pnpm overrides init` makes it). Any cell you leave out keeps whippletree's suggestion. A value is one of:

- **a model id** — pinned: runs exactly that model until you change it.
- **`latest`** — follows the newest: Claude's family alias (`opus`, …), or Codex's and Grok's own default.
- **`none`** — no pick. For `deep` → `rival`, that turns the rival review off.

```json
{
  "models": {
    "workhorse": { "rival": "gpt-6.1-sol" },
    "deep": { "home": "latest" },
    "quick": { "wildcard": "none" }
  }
}
```

Then check it. A misspelled tier or lineage fails with the valid names rather than being ignored.

```bash
pnpm models
```

## 6. When new models ship

Whippletree updates its suggestions (and the catalog) in `model-tiers.json`. `pnpm harness:pull` brings that as a diff you can take or leave ([keeping in step](keeping-in-step.md)); your `agent-overrides.json` is never touched. A pinned id keeps running the old model until you change it, which is the point: a model change changes how every plan behaves, so it should be a diff someone read.
