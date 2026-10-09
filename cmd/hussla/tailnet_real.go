//go:build !faketailnet

// The real tailnet node: embedded Tailscale (tsnet), serving HTTPS on the node's ts.net name.
// In the app: every build people run; only `go build -tags faketailnet` (the end-to-end test image) swaps it for the fake.
// Used by: serve.go.
// Uses: internal/adapters/tailnet.

package main

import "github.com/bretperry/hussla/internal/adapters/tailnet"

// tailnetHTTPS is true: the tailnet door is HTTPS with the node's certificate.
const tailnetHTTPS = true

func newTailnetNode(options tailnet.Options) tailnetNode {
	return tailnet.New(options)
}
