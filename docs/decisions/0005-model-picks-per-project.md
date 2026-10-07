# 0005. Each project picks its models; whippletree suggests pinned defaults

`accepted` · 2026-10-04 · from the "ChatGPT as rival reviewer" project thread

## Context

- Plans name a tier (`quick`, `workhorse`, `deep`, `frontier`), never a model, and the tier → model table lived in `plans.mdc`, a harness file. A project could not change one cell without skipping the whole rule.
- Three lineages (home, rival, wildcard) run on different tools, and projects differ in budget and in which accounts they have.
- Following "latest" means a model swap changes every plan's behavior with no diff to review.

## Decision

- `model-tiers.json` (harness) holds whippletree's suggested pick per tier and lineage, with the id each tool takes. Whippletree updates it when a model ships; `harness:pull` delivers that as a diff.
- `model-tiers.project.json` (project, optional) overrides any cell with a model id, `latest`, or `none`. An unknown tier, lineage, or empty value fails loudly.
- `scripts/model-tiers.mjs` (`pnpm models`) resolves the table; the showrunner and `pnpm rival` read it. No other harness file may name a model (`scripts/model-tiers.test.mjs`).
- The template default is pinned suggestions, chosen by Bret on 2026-10-04 over "latest".

## Consequences

- A project changes models without touching plans or harness rules, and a new model is one reviewed edit upstream.
- Someone has to keep the suggestions current; a stale suggestion keeps running an older model until it is bumped.
- The wildcard lineage is xAI's Grok (Bret, 2026-10-04), replacing Gemini.
- `model-tiers.json` → `catalog` lists every model each vendor offers (Anthropic, OpenAI, xAI, Google, GitHub Copilot) with a suggested tier, and a test keeps every pinned suggestion inside its vendor's list. The Grok ids came from docs and still need a check against the Grok CLI.
