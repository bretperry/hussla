// The tokens table: agent keys, stored only as hashes.
// In the app: Settings -> agents (create, list, revoke) and the bearer check on every agent request.
// Used by: the units of work in store.go (Tx.Tokens).
// Uses: internal/app/tokens (the port).
//
// Revoke and Touch are conditional updates (the WHERE clause is the rule), so two revokes keep the
// first time and a late Touch never moves last-used backwards.

package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/tokens"
)

const tokenSelect = `SELECT id, name, hash, createdAt, lastUsedAt, revokedAt FROM tokens`

type tokenRepository struct{ unit *unit }

var _ tokens.Repository = tokenRepository{}

func (u *unit) Tokens() tokens.Repository { return tokenRepository{unit: u} }

func (r tokenRepository) Create(ctx context.Context, token tokens.Token) error {
	_, err := r.unit.exec(ctx, `INSERT INTO tokens (id, name, hash, createdAt, lastUsedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)`,
		token.ID, token.Name, token.Hash, requiredTimeArg(token.CreatedAt), timeArg(token.LastUsedAt), timeArg(token.RevokedAt))
	if isUniqueViolation(err) {
		return storeerr.ErrExists
	}
	if err != nil {
		return fmt.Errorf("create token %s: %w", token.ID, err)
	}
	return nil
}

func (r tokenRepository) GetByHash(ctx context.Context, hash string) (tokens.Token, error) {
	token, err := scanToken(r.unit.queryRow(ctx, tokenSelect+` WHERE hash = ?`, hash))
	if errors.Is(err, sql.ErrNoRows) {
		return tokens.Token{}, storeerr.ErrNotFound
	}
	if err != nil {
		return tokens.Token{}, fmt.Errorf("get token by hash: %w", err)
	}
	return token, nil
}

func (r tokenRepository) List(ctx context.Context) ([]tokens.Token, error) {
	rows, err := r.unit.query(ctx, tokenSelect+` ORDER BY createdAt, id`)
	if err != nil {
		return nil, fmt.Errorf("list tokens: %w", err)
	}
	defer rows.Close() //nolint:errcheck // read cursor; rows.Err below reports failures
	var found []tokens.Token
	for rows.Next() {
		token, err := scanToken(rows)
		if err != nil {
			return nil, fmt.Errorf("list tokens: %w", err)
		}
		found = append(found, token)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list tokens: %w", err)
	}
	return found, nil
}

func (r tokenRepository) Revoke(ctx context.Context, id string, at time.Time) (bool, error) {
	result, err := r.unit.exec(ctx, `UPDATE tokens SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL`, requiredTimeArg(at), id)
	if err != nil {
		return false, fmt.Errorf("revoke token %s: %w", id, err)
	}
	return r.changedOrNotFound(ctx, result, id)
}

func (r tokenRepository) Touch(ctx context.Context, id string, at time.Time) error {
	result, err := r.unit.exec(ctx, `UPDATE tokens SET lastUsedAt = ? WHERE id = ? AND (lastUsedAt IS NULL OR lastUsedAt < ?)`,
		requiredTimeArg(at), id, requiredTimeArg(at))
	if err != nil {
		return fmt.Errorf("touch token %s: %w", id, err)
	}
	_, err = r.changedOrNotFound(ctx, result, id)
	return err
}

// changedOrNotFound reports whether the update changed a row; when it changed none, it tells
// "already in that state" (false, nil) from "no such key" (ErrNotFound).
func (r tokenRepository) changedOrNotFound(ctx context.Context, result sql.Result, id string) (bool, error) {
	changed, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("token %s: %w", id, err)
	}
	if changed > 0 {
		return true, nil
	}
	var found string
	err = r.unit.queryRow(ctx, `SELECT id FROM tokens WHERE id = ?`, id).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, storeerr.ErrNotFound
	}
	if err != nil {
		return false, fmt.Errorf("token %s: %w", id, err)
	}
	return false, nil
}

func scanToken(row scanner) (tokens.Token, error) {
	var (
		token                 tokens.Token
		createdAt             string
		lastUsedAt, revokedAt sql.NullString
	)
	if err := row.Scan(&token.ID, &token.Name, &token.Hash, &createdAt, &lastUsedAt, &revokedAt); err != nil {
		return tokens.Token{}, err //nolint:wrapcheck // callers distinguish sql.ErrNoRows and add the context themselves
	}
	token.CreatedAt = timeFrom(sql.NullString{String: createdAt, Valid: true})
	token.LastUsedAt = timeFrom(lastUsedAt)
	token.RevokedAt = timeFrom(revokedAt)
	return token, nil
}
