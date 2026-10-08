# 0009. The API contract is api/openapi.yaml; writes are three-state patches that keep unlisted fields

`accepted` · 2026-10-08 · from `docs/plans/hussla-v1.md` Phase 1

## Context

- The Go server and the React UI share no code (0008), so the wire shapes need one source.
- Agents on other computers already speak the prototype's API: PATCH names only what changed, `null` clears, `followup` merges by key, and they send fields the docs never listed (`statusNote`, `descriptionFetchedAt`).
- openapi-typescript prints through the TypeScript 5 compiler API; this project compiles with TypeScript 7, which has no JS compiler API.

## Decision

- `api/openapi.yaml` is the contract. `src/shared/api-types.ts` is generated from it (`pnpm api:types`, openapi-typescript, exact-pinned) and is never edited by hand. The project pack `stacks/api/pack.json` declares it as a generated file, so `pnpm check` and CI fail when it is stale.
- `.pnpmfile.cjs` gives openapi-typescript a private TypeScript 5.9.3; nothing else sees it.
- Every write is a patch of `domain.Field[T]` values (absent, set, cleared). A job's or company's unlisted top-level keys are kept verbatim as extras (at most 50) and come back on read; nested objects are typed, and unknown nested keys are dropped.
- Every patch names its writer (owner or agent). Each job, company and answer keeps `writers`: the last writer per field API name (`notes`, `followup.body`, an extra key), recording only owner entries since agent is the default. An agent patch that would change an owner-written field is refused whole (`OwnerFieldsError`, 409 `owner-field`, naming the fields); resending the owner's value unchanged is allowed. Every patch result carries the record before it and the changed names, for the activity log and restore.
- Emails carry a `version` (1, bumped by every content edit); approve names the version the owner read and a mismatch is refused (`StaleVersionError`, 409 `changed-since-read`).
- Times are fixed-width UTC milliseconds (`domain.FormatTimestamp`, `2006-01-02T15:04:05.000Z`).
- Responses: text is always a string (`""` when empty); numbers and timestamps that may be unknown are `null`.

## Consequences

- A field added to the domain must be added to the contract, or the UI can't see it; the regenerated types make the gap visible at compile time.
- Agents keep working unchanged, at the cost of extras the UI can't render by name.
- Drop `.pnpmfile.cjs` when openapi-typescript supports TypeScript 7 (or the project compiler moves back).
- Provenance is per field, not per list item: once the owner edits a job's contacts list, an agent can't add a contact to it until the owner hands the field back. Revisit (per-item writers) if that blocks real agent work.
- Revisit extras if agents start storing junk there; refusing unknown keys is the stricter alternative.
