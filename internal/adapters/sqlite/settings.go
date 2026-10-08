// The settings table (the prototype's `config` table): small named values the owner or the wizard chose.
// In the app: Settings, the search configuration the agents read, the mail window.
// Used by: the units of work in store.go (Tx.Settings); the seed import.
// Uses: internal/app/settings (the port).

package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/bretperry/hussla/internal/app/settings"
	"github.com/bretperry/hussla/internal/app/storeerr"
)

type settingRepository struct{ unit *unit }

var _ settings.Repository = settingRepository{}

func (u *unit) Settings() settings.Repository { return settingRepository{unit: u} }

func (r settingRepository) Get(ctx context.Context, key string) (string, error) {
	var value string
	err := r.unit.queryRow(ctx, `SELECT value FROM config WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", storeerr.ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("get setting %s: %w", key, err)
	}
	return value, nil
}

func (r settingRepository) Set(ctx context.Context, key, value string) error {
	if _, err := r.unit.exec(ctx, `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value); err != nil {
		return fmt.Errorf("set setting %s: %w", key, err)
	}
	return nil
}

func (r settingRepository) All(ctx context.Context) (map[string]string, error) {
	rows, err := r.unit.query(ctx, `SELECT key, value FROM config`)
	if err != nil {
		return nil, fmt.Errorf("list settings: %w", err)
	}
	defer rows.Close() //nolint:errcheck // closing a read-only handle loses nothing
	all := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, fmt.Errorf("list settings: %w", err)
		}
		all[key] = value
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list settings: %w", err)
	}
	return all, nil
}
