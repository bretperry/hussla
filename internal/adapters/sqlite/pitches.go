// The pitches and pitch_versions tables: the owner's ten pitches and each one's history.
// In the app: the Pitches page, the front page billboard, agents adding a version.
// Used by: the units of work in store.go (Tx.Pitches).
// Uses: internal/app/pitches (the port), migrations/0003_pitches.sql.
//
// A pitch is one row plus its version rows; Update rewrites the version rows from the record the
// domain computed, inside the caller's unit of work, so a half-written history can't be committed.

package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"

	"github.com/bretperry/hussla/internal/app/pitches"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/domain"
)

const pitchSelect = `SELECT slot, title, whenToUse, liveVersion, lastVersion, createdAt, updatedAt FROM pitches`

const versionSelect = `SELECT slot, version, text, note, author, writer, createdAt FROM pitch_versions`

type pitchRepository struct{ unit *unit }

var _ pitches.Repository = pitchRepository{}

func (u *unit) Pitches() pitches.Repository { return pitchRepository{unit: u} }

func (r pitchRepository) Get(ctx context.Context, slot int) (domain.Pitch, error) {
	pitch, err := scanPitch(r.unit.queryRow(ctx, pitchSelect+` WHERE slot = ?`, slot))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Pitch{}, storeerr.ErrNotFound
	}
	if err != nil {
		return domain.Pitch{}, fmt.Errorf("get pitch %d: %w", slot, err)
	}
	versions, err := r.versions(ctx, versionSelect+` WHERE slot = ? ORDER BY version`, slot)
	if err != nil {
		return domain.Pitch{}, err
	}
	pitch.Versions = versions[slot]
	return pitch, nil
}

func (r pitchRepository) List(ctx context.Context) ([]domain.Pitch, error) {
	rows, err := r.unit.query(ctx, pitchSelect+` ORDER BY slot`)
	if err != nil {
		return nil, fmt.Errorf("list pitches: %w", err)
	}
	defer rows.Close() //nolint:errcheck // closing a read-only handle loses nothing
	var found []domain.Pitch
	for rows.Next() {
		pitch, err := scanPitch(rows)
		if err != nil {
			return nil, fmt.Errorf("list pitches: %w", err)
		}
		found = append(found, pitch)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list pitches: %w", err)
	}
	versions, err := r.versions(ctx, versionSelect+` ORDER BY slot, version`)
	if err != nil {
		return nil, err
	}
	for index := range found {
		found[index].Versions = versions[found[index].Slot]
	}
	return found, nil
}

func (r pitchRepository) Create(ctx context.Context, pitch domain.Pitch) error {
	_, err := r.unit.exec(ctx, `INSERT INTO pitches (slot, title, whenToUse, liveVersion, lastVersion, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		pitch.Slot, pitch.Title, pitch.When, pitch.Live, pitch.LastNumber, requiredTimeArg(pitch.CreatedAt), requiredTimeArg(pitch.UpdatedAt))
	if isUniqueViolation(err) {
		return storeerr.ErrExists
	}
	if err != nil {
		return fmt.Errorf("create pitch %d: %w", pitch.Slot, err)
	}
	return r.insertVersions(ctx, pitch)
}

func (r pitchRepository) Update(ctx context.Context, pitch domain.Pitch) error {
	result, err := r.unit.exec(ctx, `UPDATE pitches SET title = ?, whenToUse = ?, liveVersion = ?, lastVersion = ?, createdAt = ?, updatedAt = ? WHERE slot = ?`,
		pitch.Title, pitch.When, pitch.Live, pitch.LastNumber, requiredTimeArg(pitch.CreatedAt), requiredTimeArg(pitch.UpdatedAt), pitch.Slot)
	if err != nil {
		return fmt.Errorf("update pitch %d: %w", pitch.Slot, err)
	}
	if err := requireRow(result, "update pitch "+strconv.Itoa(pitch.Slot)); err != nil {
		return err
	}
	if _, err := r.unit.exec(ctx, `DELETE FROM pitch_versions WHERE slot = ?`, pitch.Slot); err != nil {
		return fmt.Errorf("rewrite pitch %d versions: %w", pitch.Slot, err)
	}
	return r.insertVersions(ctx, pitch)
}

func (r pitchRepository) Delete(ctx context.Context, slot int) error {
	// The versions go first even though the foreign key cascades, so the delete doesn't depend on the pragma.
	if _, err := r.unit.exec(ctx, `DELETE FROM pitch_versions WHERE slot = ?`, slot); err != nil {
		return fmt.Errorf("delete pitch %d versions: %w", slot, err)
	}
	result, err := r.unit.exec(ctx, `DELETE FROM pitches WHERE slot = ?`, slot)
	if err != nil {
		return fmt.Errorf("delete pitch %d: %w", slot, err)
	}
	return requireRow(result, "delete pitch "+strconv.Itoa(slot))
}

func (r pitchRepository) insertVersions(ctx context.Context, pitch domain.Pitch) error {
	for _, version := range pitch.Versions {
		_, err := r.unit.exec(ctx, `INSERT INTO pitch_versions (slot, version, text, note, author, writer, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			pitch.Slot, version.Number, version.Text, version.Note, version.Author, version.Writer.String(), requiredTimeArg(version.CreatedAt))
		if err != nil {
			return fmt.Errorf("store pitch %d version %d: %w", pitch.Slot, version.Number, err)
		}
	}
	return nil
}

// versions reads version rows, grouped by slot, each group oldest first.
func (r pitchRepository) versions(ctx context.Context, query string, args ...any) (map[int][]domain.PitchVersion, error) {
	rows, err := r.unit.query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list pitch versions: %w", err)
	}
	defer rows.Close() //nolint:errcheck // closing a read-only handle loses nothing
	grouped := map[int][]domain.PitchVersion{}
	for rows.Next() {
		var (
			slot              int
			version           domain.PitchVersion
			writer, createdAt string
		)
		if err := rows.Scan(&slot, &version.Number, &version.Text, &version.Note, &version.Author, &writer, &createdAt); err != nil {
			return nil, fmt.Errorf("list pitch versions: %w", err)
		}
		// An unreadable writer reads as an agent: the restricted kind (fail closed).
		version.Writer, _ = domain.ParseWriter(writer)
		version.CreatedAt = timeFrom(sql.NullString{String: createdAt, Valid: true})
		grouped[slot] = append(grouped[slot], version)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list pitch versions: %w", err)
	}
	return grouped, nil
}

func scanPitch(row scanner) (domain.Pitch, error) {
	var (
		pitch                domain.Pitch
		createdAt, updatedAt string
	)
	if err := row.Scan(&pitch.Slot, &pitch.Title, &pitch.When, &pitch.Live, &pitch.LastNumber, &createdAt, &updatedAt); err != nil {
		return domain.Pitch{}, err //nolint:wrapcheck // callers distinguish sql.ErrNoRows and add the context themselves
	}
	pitch.CreatedAt = timeFrom(sql.NullString{String: createdAt, Valid: true})
	pitch.UpdatedAt = timeFrom(sql.NullString{String: updatedAt, Valid: true})
	return pitch, nil
}
