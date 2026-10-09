//go:build faketailnet

// The end-to-end test build's tailnet: a fake that signs in from its own login page and serves plain HTTP on localhost.
// In the app: never. Only `go build -tags faketailnet` (the Dockerfile's e2e target) compiles this file; every release build compiles tailnet_real.go instead.
// Used by: serve.go.
// Uses: internal/testsupport/faketailnet (it says how Tailscale is faked).

package main

import (
	"github.com/bretperry/hussla/internal/adapters/tailnet"
	"github.com/bretperry/hussla/internal/testsupport/faketailnet"
)

// tailnetHTTPS is false: the fake tailnet door is http://localhost:<port>.
const tailnetHTTPS = false

func newTailnetNode(options tailnet.Options) tailnetNode {
	return faketailnet.New(faketailnet.Options{DataDir: options.DataDir, Logf: options.Logf})
}
