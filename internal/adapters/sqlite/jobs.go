// The jobs table: the jobs repository, mapping domain.Job to indexed columns plus one JSON cell.
// In the app: the jobs table page, the job page, every agent write to a job.
// Used by: the units of work in store.go (Tx.Jobs).
// Uses: internal/app/wire (the API-named JSON of a job), internal/app/jobs (the port).
//
// Row shape (the prototype's, kept so its database opens as is): the columns the pages filter
// and sort on are real columns; everything else, extras included, is API-named JSON in `data`;
// `writers` holds the owner-written field names. On read the columns win over `data`, so a
// prototype row, whose `data` never held them, and a row this code wrote read the same way.

package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

// jobColumnKeys are the job fields stored as columns, so they are left out of `data`.
var jobColumnKeys = []string{
	"id", "company", "companySlug", "title", "status", "score", "url", "location", "workType",
	"salaryMin", "salaryMax", "payText", "source", "resume", "resumeSent", "foundAt", "appliedAt",
	"nextAction", "nextActionDue", "createdAt", "updatedAt",
}

const jobSelect = `SELECT id, company, companySlug, title, status, score, url, location, workType,
	salaryMin, salaryMax, payText, source, resume, resumeSent, foundAt, appliedAt,
	nextAction, nextActionDue, data, writers, createdAt, updatedAt FROM jobs`

type jobRepository struct{ unit *unit }

var _ jobs.Repository = jobRepository{}

func (u *unit) Jobs() jobs.Repository { return jobRepository{unit: u} }

func (r jobRepository) Get(ctx context.Context, id string) (domain.Job, error) {
	job, err := scanJob(r.unit.queryRow(ctx, jobSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Job{}, storeerr.ErrNotFound
	}
	if err != nil {
		return domain.Job{}, fmt.Errorf("get job %s: %w", id, err)
	}
	return job, nil
}

func (r jobRepository) List(ctx context.Context, filter jobs.Filter) ([]domain.Job, error) {
	var conditions []string
	var args []any
	if filter.Status != nil {
		conditions = append(conditions, "status = ?")
		args = append(args, filter.Status.String())
	}
	if filter.CompanySlug != "" {
		conditions = append(conditions, "companySlug = ?")
		args = append(args, filter.CompanySlug)
	}
	query := jobSelect
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY createdAt DESC, id"
	if filter.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, filter.Limit)
	}
	rows, err := r.unit.query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	defer rows.Close() //nolint:errcheck // closing a read-only handle loses nothing
	var found []domain.Job
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, fmt.Errorf("list jobs: %w", err)
		}
		found = append(found, job)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	return found, nil
}

func (r jobRepository) Create(ctx context.Context, job domain.Job) error {
	data, err := jobData(job)
	if err != nil {
		return err
	}
	_, err = r.unit.exec(ctx, `INSERT INTO jobs (id, company, companySlug, title, status, score, url, location, workType,
		salaryMin, salaryMax, payText, source, resume, resumeSent, foundAt, appliedAt, nextAction, nextActionDue,
		data, writers, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		append([]any{job.ID}, jobValues(job, data)...)...)
	if isUniqueViolation(err) {
		return storeerr.ErrExists
	}
	if err != nil {
		return fmt.Errorf("create job %s: %w", job.ID, err)
	}
	return nil
}

func (r jobRepository) Update(ctx context.Context, job domain.Job) error {
	data, err := jobData(job)
	if err != nil {
		return err
	}
	result, err := r.unit.exec(ctx, `UPDATE jobs SET company = ?, companySlug = ?, title = ?, status = ?, score = ?, url = ?,
		location = ?, workType = ?, salaryMin = ?, salaryMax = ?, payText = ?, source = ?, resume = ?, resumeSent = ?,
		foundAt = ?, appliedAt = ?, nextAction = ?, nextActionDue = ?, data = ?, writers = ?, createdAt = ?, updatedAt = ?
		WHERE id = ?`, append(jobValues(job, data), job.ID)...)
	if err != nil {
		return fmt.Errorf("update job %s: %w", job.ID, err)
	}
	return requireRow(result, "update job "+job.ID)
}

func (r jobRepository) Delete(ctx context.Context, id string) error {
	result, err := r.unit.exec(ctx, `DELETE FROM jobs WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete job %s: %w", id, err)
	}
	return requireRow(result, "delete job "+id)
}

// jobValues are a job's column values after id, in the order Create and Update list them.
func jobValues(job domain.Job, data string) []any {
	return []any{
		job.Company, job.CompanySlug, job.Title, job.Status.String(), intArg(job.Score), job.URL, job.Location,
		job.WorkType.String(), intArg(job.SalaryMin), intArg(job.SalaryMax), job.PayText, job.Source, job.Resume,
		job.ResumeSent, timeArg(job.FoundAt), timeArg(job.AppliedAt), job.NextAction, job.NextActionDue,
		data, wire.EncodeWriters(job.Writers), requiredTimeArg(job.CreatedAt), requiredTimeArg(job.UpdatedAt),
	}
}

// jobData is the JSON for the `data` cell: every named field that has no column, and the extras.
func jobData(job domain.Job) (string, error) {
	object := wire.JobObject(job)
	for _, key := range jobColumnKeys {
		delete(object, key)
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return "", fmt.Errorf("encode job %s: %w", job.ID, err)
	}
	return string(encoded), nil
}

type scanner interface{ Scan(dest ...any) error }

func scanJob(row scanner) (domain.Job, error) {
	var (
		id, company, companySlug, title, status, data, writers, createdAt, updatedAt string
		score, salaryMin, salaryMax                                                  sql.NullInt64
		url, location, workType, payText, source, resume, resumeSent                 sql.NullString
		foundAt, appliedAt, nextAction, nextActionDue                                sql.NullString
	)
	if err := row.Scan(&id, &company, &companySlug, &title, &status, &score, &url, &location, &workType,
		&salaryMin, &salaryMax, &payText, &source, &resume, &resumeSent, &foundAt, &appliedAt,
		&nextAction, &nextActionDue, &data, &writers, &createdAt, &updatedAt); err != nil {
		return domain.Job{}, err //nolint:wrapcheck // callers distinguish sql.ErrNoRows and add the context themselves
	}
	object, err := wire.ParseObject([]byte(defaultObject(data)))
	if err != nil {
		return domain.Job{}, fmt.Errorf("job %s has damaged data: %w", id, err)
	}
	columns := columnSet{object: object}
	columns.text("id", id)
	columns.text("company", company)
	columns.text("companySlug", companySlug)
	columns.text("title", title)
	columns.text("status", status)
	columns.number("score", score)
	columns.nullText("url", url)
	columns.nullText("location", location)
	columns.nullText("workType", workType)
	columns.number("salaryMin", salaryMin)
	columns.number("salaryMax", salaryMax)
	columns.nullText("payText", payText)
	columns.nullText("source", source)
	columns.nullText("resume", resume)
	columns.nullText("resumeSent", resumeSent)
	columns.nullText("foundAt", foundAt)
	columns.nullText("appliedAt", appliedAt)
	columns.nullText("nextAction", nextAction)
	columns.nullText("nextActionDue", nextActionDue)
	columns.text("createdAt", createdAt)
	columns.text("updatedAt", updatedAt)
	job, _ := wire.DecodeJob(object) // warnings: a stored value that no longer reads is skipped, not fatal
	job.Writers, err = wire.DecodeWriters(writers)
	if err != nil {
		return domain.Job{}, fmt.Errorf("job %s: %w", id, err)
	}
	return job, nil
}
