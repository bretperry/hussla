// "Search now" knobs: where a Claude routine is fired from, and how often the button may fire it.
// In the app: the Search now button on the Jobs page and its setup in Settings → Job search.
// Used by: internal/app/searchrun (the cooldown), internal/adapters/routinefire (the endpoint and its headers).
//
// The routine's API trigger is in research preview: its beta header is dated, and a newer header
// may replace it (https://code.claude.com/docs/en/routines → Trigger a routine). Bump it here.

package config

import "time"

// RoutineFireBaseURL is the only host the routine token is ever sent to; the owner pastes a routine
// id or its URL, and the adapter builds the URL from this base, so a pasted URL can't redirect the token.
const RoutineFireBaseURL = "https://api.anthropic.com"

// RoutineFireBeta is the beta header the /fire endpoint ships under.
const RoutineFireBeta = "experimental-cc-routine-2026-04-01"

// RoutineFireAPIVersion is the anthropic-version header the /fire endpoint expects.
const RoutineFireAPIVersion = "2023-06-01"

// RoutineFireTimeout bounds one fire request, connect to reply.
const RoutineFireTimeout = 30 * time.Second

// SearchRunCooldown is how soon after one search the button can start another: a double click, or
// a second tab, would otherwise start two paid runs that find the same jobs.
const SearchRunCooldown = 5 * time.Minute
