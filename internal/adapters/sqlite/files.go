// The files table: the record of each file attached to a job.
// In the app: the job page's file list and GET /api/files/:id.
// Used by: the units of work in store.go (Tx.Files).
// Uses: internal/app/files (the port). The bytes are not here (Phase 3 decides where they live).

package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/bretperry/hussla/internal/app/files"
	"github.com/bretperry/hussla/internal/app/storeerr"
)

const fileSelect = `SELECT id, jobId, name, kind, mime, size, createdAt, actor FROM files`

type fileRepository struct{ unit *unit }

var _ files.Repository = fileRepository{}

func (u *unit) Files() files.Repository { return fileRepository{unit: u} }

func (r fileRepository) Get(ctx context.Context, id string) (files.File, error) {
	file, err := scanFile(r.unit.queryRow(ctx, fileSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return files.File{}, storeerr.ErrNotFound
	}
	if err != nil {
		return files.File{}, fmt.Errorf("get file %s: %w", id, err)
	}
	return file, nil
}

func (r fileRepository) ListByJob(ctx context.Context, jobID string) ([]files.File, error) {
	rows, err := r.unit.query(ctx, fileSelect+` WHERE jobId = ? ORDER BY createdAt, id`, jobID)
	if err != nil {
		return nil, fmt.Errorf("list files: %w", err)
	}
	defer rows.Close() //nolint:errcheck // read cursor; rows.Err below reports failures
	var found []files.File
	for rows.Next() {
		file, err := scanFile(rows)
		if err != nil {
			return nil, fmt.Errorf("list files: %w", err)
		}
		found = append(found, file)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list files: %w", err)
	}
	return found, nil
}

func (r fileRepository) Create(ctx context.Context, file files.File) error {
	_, err := r.unit.exec(ctx, `INSERT INTO files (id, jobId, name, kind, mime, size, createdAt, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		file.ID, nullable(file.JobID), file.Name, file.Kind, file.Mime, file.Size, requiredTimeArg(file.CreatedAt), file.Actor)
	if isUniqueViolation(err) {
		return storeerr.ErrExists
	}
	if err != nil {
		return fmt.Errorf("create file %s: %w", file.ID, err)
	}
	return nil
}

func (r fileRepository) Delete(ctx context.Context, id string) error {
	result, err := r.unit.exec(ctx, `DELETE FROM files WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete file %s: %w", id, err)
	}
	return requireRow(result, "delete file "+id)
}

func scanFile(row scanner) (files.File, error) {
	var (
		file      files.File
		jobID     sql.NullString
		createdAt string
	)
	if err := row.Scan(&file.ID, &jobID, &file.Name, &file.Kind, &file.Mime, &file.Size, &createdAt, &file.Actor); err != nil {
		return files.File{}, err //nolint:wrapcheck // callers distinguish sql.ErrNoRows and add the context themselves
	}
	file.JobID = jobID.String
	file.CreatedAt = timeFrom(sql.NullString{String: createdAt, Valid: true})
	return file, nil
}
