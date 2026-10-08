// Storage knobs: how long a busy database is waited on and how backups are kept.
// In the app: the SQLite adapter's open, its daily and before-migration backups.
// Used by: internal/adapters/sqlite; the composition root's daily backup tick (Phase 3).
// Uses: time.
//
// Why 7 backups and a day: a laptop is on a few hours at a time, so "daily" means "the first
// start after a day has passed"; seven good copies reach back a week without filling a NAS.

package config

import "time"

// BackupsKept is how many good backups survive pruning. Only a new, integrity-checked backup
// triggers a prune, so a failed backup never costs an old one.
const BackupsKept = 7

// BackupInterval is the longest the newest daily backup may age before another is due.
const BackupInterval = 24 * time.Hour

// StorageBusyTimeout is how long a write waits for a lock another connection holds (a backup
// tool copying the file, say) before it fails.
const StorageBusyTimeout = 5 * time.Second
