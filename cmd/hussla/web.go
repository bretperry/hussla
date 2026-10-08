// The web app built into the binary: whatever is in cmd/hussla/web at build time.
// In the app: every page the owner opens (served by the HTTP layer's UI fallback).
// Used by: serve.go (buildServices).
//
// Phase 5's Vite build writes its output here; until then a placeholder page says the API is up.

package main

import "embed"

//go:embed all:web
var webApp embed.FS
