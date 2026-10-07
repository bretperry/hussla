// Package app is the root of Hussla's use-cases. Each use-case lives in its own package under
// internal/app/<name> with the ports it needs; the HTTP layer and the composition root in
// cmd/hussla call them, never an adapter directly.
package app
