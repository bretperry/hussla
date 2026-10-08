// Package adapters is the root of Hussla's I/O: one package per vendor or mechanism under
// internal/adapters/<name> (SQLite storage, SMTP and HTTP mail senders, the encrypted secret
// store). Each implements a port from internal/app; only cmd/hussla wires them in.
package adapters
