// Attached files and résumés on disk, in folders beside the database.
// In the app: the bytes behind GET /api/files/:id and /resumes/<name>.
// Used by: cmd/hussla (attachments.Blobs and attachments.Resumes).
// Uses: <DATA_DIR>/files/<id> and <DATA_DIR>/resumes/<name>.
//
// A blob is written to a temp file, synced, then renamed into place, so a crash never leaves a
// half file under a real id. Ids and names are checked against a strict pattern before they touch
// a path, so nothing reaches outside the folder. The install guides' "copy backups off the device"
// must cover the files folder too (docs/deferred.md).

package filestore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/bretperry/hussla/internal/app/attachments"
	"github.com/bretperry/hussla/internal/app/storeerr"
)

// safeName is what an id or résumé name may look like: no separators, no leading dot.
var safeName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,159}$`)

// Blobs stores file bytes under a folder.
type Blobs struct {
	dir string
}

// NewBlobs uses dir (created 0700 when missing).
func NewBlobs(dir string) (*Blobs, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("files folder: %w", err)
	}
	return &Blobs{dir: dir}, nil
}

func (blobs *Blobs) path(id string) (string, error) {
	if !safeName.MatchString(id) {
		return "", storeerr.ErrNotFound
	}
	return filepath.Join(blobs.dir, id), nil
}

// Put stores at most limit bytes; attachments.ErrTooLarge when the body is longer.
func (blobs *Blobs) Put(_ context.Context, id string, body io.Reader, limit int64) (int64, error) {
	target, err := blobs.path(id)
	if err != nil {
		return 0, err
	}
	temp, err := os.CreateTemp(blobs.dir, ".upload-*")
	if err != nil {
		return 0, fmt.Errorf("start file: %w", err)
	}
	defer func() { _ = os.Remove(temp.Name()) }()
	size, err := io.Copy(temp, io.LimitReader(body, limit+1))
	if err == nil && size > limit {
		err = attachments.ErrTooLarge
	}
	if err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return 0, fmt.Errorf("write file: %w", err)
	}
	if err := os.Rename(temp.Name(), target); err != nil {
		return 0, fmt.Errorf("place file: %w", err)
	}
	return size, nil
}

// Open reads a blob; storeerr.ErrNotFound when missing.
func (blobs *Blobs) Open(_ context.Context, id string) (io.ReadCloser, error) {
	target, err := blobs.path(id)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(target)
	if errors.Is(err, os.ErrNotExist) {
		return nil, storeerr.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("open file: %w", err)
	}
	return file, nil
}

// Delete removes a blob; a missing one is fine.
func (blobs *Blobs) Delete(_ context.Context, id string) error {
	target, err := blobs.path(id)
	if err != nil {
		return nil //nolint:nilerr // an id that can't name a file has nothing to delete
	}
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete file: %w", err)
	}
	return nil
}

// Resumes reads the résumé folder.
type Resumes struct {
	dir string
}

// NewResumes uses dir (created 0700 when missing).
func NewResumes(dir string) (*Resumes, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("résumés folder: %w", err)
	}
	return &Resumes{dir: dir}, nil
}

// List returns the regular files in the folder, by name.
func (resumes *Resumes) List(_ context.Context) ([]attachments.Resume, error) {
	entries, err := os.ReadDir(resumes.dir)
	if err != nil {
		return nil, fmt.Errorf("list résumés: %w", err)
	}
	var list []attachments.Resume
	for _, entry := range entries {
		if !entry.Type().IsRegular() || strings.HasPrefix(entry.Name(), ".") || !safeName.MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		list = append(list, attachments.Resume{Name: entry.Name(), Size: info.Size()})
	}
	sort.Slice(list, func(left, right int) bool { return list[left].Name < list[right].Name })
	return list, nil
}

// Open reads one résumé by exact name; storeerr.ErrNotFound when missing or unsafe.
func (resumes *Resumes) Open(_ context.Context, name string) (io.ReadCloser, error) {
	if !safeName.MatchString(name) {
		return nil, storeerr.ErrNotFound
	}
	file, err := os.Open(filepath.Join(resumes.dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, storeerr.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("open résumé: %w", err)
	}
	return file, nil
}
