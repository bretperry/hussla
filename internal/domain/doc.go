// Package domain holds Hussla's pure rules: jobs, companies, contacts, reviews, emails and their
// state machine, send pacing, and patch merging. No I/O and no third-party packages
// (depguard in .golangci.yml); every adapter builds these types and every use-case speaks them.
package domain
