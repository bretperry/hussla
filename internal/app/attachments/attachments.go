// Attached files and résumés: a job's cover letter, confirmation or screenshot, and the résumé files agents name.
// In the app: the job page's file list, GET /api/files/:id, Settings → résumés, GET /api/resumes.
// Used by: internal/httpapi file routes. The bytes live behind the Blobs port (internal/adapters/filestore,
// a folder beside the database); the record lives in the files repository.
//
// A record and its bytes are written in order bytes-then-record, and removed record-then-bytes, so a
// crash between the two leaves at worst an orphan blob nobody links to, never a record with no bytes.

package attachments

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/files"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/domain"
)

// Blobs stores file bytes by id.
type Blobs interface {
	// Put stores at most limit bytes from body under id; ErrTooLarge when there are more.
	Put(ctx context.Context, id string, body io.Reader, limit int64) (size int64, err error)
	// Open reads the bytes; storeerr.ErrNotFound when missing.
	Open(ctx context.Context, id string) (io.ReadCloser, error)
	// Delete removes the bytes; missing is not an error.
	Delete(ctx context.Context, id string) error
}

// Resume is one résumé file on the server.
type Resume struct {
	Name string
	Size int64
}

// Resumes lists and opens the résumé folder.
type Resumes interface {
	List(ctx context.Context) ([]Resume, error)
	// Open reads one by exact file name; storeerr.ErrNotFound when missing or the name is unsafe.
	Open(ctx context.Context, name string) (io.ReadCloser, error)
}

// ErrTooLarge: the upload is over the limit.
var ErrTooLarge = errors.New("the file is too large")

// Service runs the file use-cases.
type Service struct {
	store   store.Store
	blobs   Blobs
	resumes Resumes
	limit   int64
	now     func() time.Time
}

// New builds the Service.
func New(target store.Store, blobs Blobs, resumes Resumes, limit int64, now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}
	return &Service{store: target, blobs: blobs, resumes: resumes, limit: limit, now: now}
}

// SafeFileName keeps letters, digits, dot, dash and underscore; anything else becomes "_".
func SafeFileName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "upload.bin"
	}
	var builder strings.Builder
	for _, character := range name {
		switch {
		case character >= 'a' && character <= 'z', character >= 'A' && character <= 'Z', character >= '0' && character <= '9',
			character == '.', character == '-', character == '_':
			builder.WriteRune(character)
		default:
			builder.WriteByte('_')
		}
	}
	safe := strings.TrimLeft(builder.String(), ".")
	if safe == "" {
		return "upload.bin"
	}
	if len(safe) > 120 {
		safe = safe[:120]
	}
	return safe
}

// Upload stores a file on a job and logs it.
func (s *Service) Upload(ctx context.Context, actor, jobID, name, kind, mime string, body io.Reader) (files.File, error) {
	if err := s.store.View(ctx, func(tx store.Tx) error {
		_, err := tx.Jobs().Get(ctx, jobID)
		return err
	}); err != nil {
		return files.File{}, fmt.Errorf("upload to %s: %w", jobID, err)
	}
	kind = strings.TrimSpace(kind)
	if kind == "" {
		kind = "file"
	}
	if !domain.IsValidRecordID(kind) {
		return files.File{}, &domain.ValidationError{Field: "kind", Problem: "must be a short lowercase word like cover-letter"}
	}
	if mime == "" || strings.ContainsAny(mime, "\r\n") || len(mime) > 200 {
		mime = "application/octet-stream"
	}
	buffer := make([]byte, 12)
	_, _ = rand.Read(buffer)
	id := "f" + hex.EncodeToString(buffer)
	size, err := s.blobs.Put(ctx, id, body, s.limit)
	if err != nil {
		return files.File{}, fmt.Errorf("store file bytes: %w", err)
	}
	record := files.File{ID: id, JobID: jobID, Name: SafeFileName(name), Kind: kind, Mime: mime, Size: size, CreatedAt: domain.NormalizeTime(s.now()), Actor: actor}
	err = s.store.Atomically(ctx, func(tx store.Tx) error {
		if err := tx.Files().Create(ctx, record); err != nil {
			return err
		}
		event, err := domain.NewEvent(jobID, actor, "Attached "+kind, record.Name, s.now())
		if err != nil {
			return err
		}
		_, err = tx.Events().Append(ctx, event)
		return err
	})
	if err != nil {
		_ = s.blobs.Delete(ctx, id)
		return files.File{}, fmt.Errorf("record file: %w", err)
	}
	return record, nil
}

// Open returns a file's record and bytes; the caller closes the reader.
func (s *Service) Open(ctx context.Context, id string) (files.File, io.ReadCloser, error) {
	var record files.File
	if err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		record, err = tx.Files().Get(ctx, id)
		return err
	}); err != nil {
		return files.File{}, nil, fmt.Errorf("file %s: %w", id, err)
	}
	reader, err := s.blobs.Open(ctx, id)
	if err != nil {
		return files.File{}, nil, fmt.Errorf("file %s bytes: %w", id, err)
	}
	return record, reader, nil
}

// Delete removes a file. Owner only: the HTTP layer checks.
func (s *Service) Delete(ctx context.Context, actor, id string) error {
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		record, err := tx.Files().Get(ctx, id)
		if err != nil {
			return err
		}
		if err := tx.Files().Delete(ctx, id); err != nil {
			return err
		}
		event, err := domain.NewEvent(record.JobID, actor, "Removed file", record.Name, s.now())
		if err != nil {
			return err
		}
		_, err = tx.Events().Append(ctx, event)
		return err
	})
	if err != nil {
		return fmt.Errorf("delete file %s: %w", id, err)
	}
	if err := s.blobs.Delete(ctx, id); err != nil {
		return fmt.Errorf("delete file %s bytes: %w", id, err)
	}
	return nil
}

// ListResumes lists the résumé files.
func (s *Service) ListResumes(ctx context.Context) ([]Resume, error) {
	list, err := s.resumes.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list résumés: %w", err)
	}
	return list, nil
}

// OpenResume reads one résumé by name.
func (s *Service) OpenResume(ctx context.Context, name string) (io.ReadCloser, error) {
	reader, err := s.resumes.Open(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("résumé %s: %w", name, err)
	}
	return reader, nil
}
