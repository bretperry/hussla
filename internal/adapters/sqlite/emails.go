// The emails table: the outbox, with every state change a conditional update.
// In the app: the Outbox page, the job and company email editors, the dispatcher that sends approved mail.
// Used by: the units of work in store.go (Tx.Emails).
// Uses: internal/app/emails (the port).
//
// Replace is the compare-and-swap from the security model: the UPDATE only matches a row still
// in the status, version and attempts the caller read, so a double click on Approve or an agent
// edit between the owner's read and click changes no row and the caller gets ErrConflict.
// Pacing is derived from the sent rows (SentHistory), never from memory.

package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/emails"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/domain"
)

const emailSelect = `SELECT id, jobId, companySlug, toAddrs, ccAddrs, subject, body, kind, status, createdBy, createdAt,
	approvedBy, approvedAt, sentAt, messageId, error, attempts, version FROM emails`

type emailRepository struct{ unit *unit }

var _ emails.Repository = emailRepository{}

func (u *unit) Emails() emails.Repository { return emailRepository{unit: u} }

func (r emailRepository) Get(ctx context.Context, id string) (domain.Email, error) {
	email, err := scanEmail(r.unit.queryRow(ctx, emailSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Email{}, storeerr.ErrNotFound
	}
	if err != nil {
		return domain.Email{}, fmt.Errorf("get email %s: %w", id, err)
	}
	return email, nil
}

func (r emailRepository) List(ctx context.Context, filter emails.Filter) ([]domain.Email, error) {
	var conditions []string
	var args []any
	if filter.Status != nil {
		conditions = append(conditions, "status = ?")
		args = append(args, filter.Status.String())
	}
	if filter.JobID != "" {
		conditions = append(conditions, "jobId = ?")
		args = append(args, filter.JobID)
	}
	if filter.CompanySlug != "" {
		conditions = append(conditions, "companySlug = ?")
		args = append(args, filter.CompanySlug)
	}
	query := emailSelect
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY createdAt DESC, id"
	if filter.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, filter.Limit)
	}
	return r.collect(ctx, "list emails", query, args...)
}

func (r emailRepository) Create(ctx context.Context, email domain.Email) error {
	toAddresses, ccAddresses, err := encodeAddresses(email)
	if err != nil {
		return err
	}
	_, err = r.unit.exec(ctx, `INSERT INTO emails (id, jobId, companySlug, toAddrs, ccAddrs, subject, body, kind, status, createdBy,
		createdAt, approvedBy, approvedAt, sentAt, messageId, error, attempts, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		email.ID, nullable(email.JobID), nullable(email.CompanySlug), toAddresses, ccAddresses, email.Subject, email.Body,
		string(email.Kind), email.Status.String(), email.CreatedBy, requiredTimeArg(email.CreatedAt),
		nullable(email.ApprovedBy), timeArg(email.ApprovedAt), timeArg(email.SentAt), nullable(email.MessageID),
		nullable(email.Error), email.Attempts, email.Version)
	if isUniqueViolation(err) {
		return storeerr.ErrExists
	}
	if err != nil {
		return fmt.Errorf("create email %s: %w", email.ID, err)
	}
	return nil
}

func (r emailRepository) Replace(ctx context.Context, was, next domain.Email) error {
	if was.ID != next.ID {
		return fmt.Errorf("replace email: ids differ (%s, %s)", was.ID, next.ID)
	}
	toAddresses, ccAddresses, err := encodeAddresses(next)
	if err != nil {
		return err
	}
	result, err := r.unit.exec(ctx, `UPDATE emails SET jobId = ?, companySlug = ?, toAddrs = ?, ccAddrs = ?, subject = ?, body = ?,
		kind = ?, status = ?, createdBy = ?, createdAt = ?, approvedBy = ?, approvedAt = ?, sentAt = ?, messageId = ?,
		error = ?, attempts = ?, version = ?
		WHERE id = ? AND status = ? AND version = ? AND attempts = ?`,
		nullable(next.JobID), nullable(next.CompanySlug), toAddresses, ccAddresses, next.Subject, next.Body,
		string(next.Kind), next.Status.String(), next.CreatedBy, requiredTimeArg(next.CreatedAt),
		nullable(next.ApprovedBy), timeArg(next.ApprovedAt), timeArg(next.SentAt), nullable(next.MessageID),
		nullable(next.Error), next.Attempts, next.Version,
		was.ID, was.Status.String(), was.Version, was.Attempts)
	if err != nil {
		return fmt.Errorf("replace email %s: %w", was.ID, err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("replace email %s: %w", was.ID, err)
	}
	if changed > 0 {
		return nil
	}
	// No row matched: either it is gone, or it moved on since the caller read it.
	var found string
	err = r.unit.queryRow(ctx, `SELECT id FROM emails WHERE id = ?`, was.ID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return storeerr.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("replace email %s: %w", was.ID, err)
	}
	return storeerr.ErrConflict
}

func (r emailRepository) NextApproved(ctx context.Context) (domain.Email, error) {
	found, err := r.collect(ctx, "next approved email", emailSelect+` WHERE status = 'approved' ORDER BY approvedAt, id LIMIT 1`)
	if err != nil {
		return domain.Email{}, err
	}
	if len(found) == 0 {
		return domain.Email{}, storeerr.ErrNotFound
	}
	return found[0], nil
}

func (r emailRepository) ListSending(ctx context.Context) ([]domain.Email, error) {
	return r.collect(ctx, "list sending emails", emailSelect+` WHERE status = 'sending' ORDER BY createdAt, id`)
}

func (r emailRepository) SentHistory(ctx context.Context, since time.Time) (emails.SendHistory, error) {
	var (
		lastSentAt sql.NullString
		sentSince  int
	)
	err := r.unit.queryRow(ctx, `SELECT MAX(sentAt), COUNT(*) FILTER (WHERE sentAt >= ?) FROM emails WHERE status = 'sent' AND sentAt IS NOT NULL`,
		requiredTimeArg(since)).Scan(&lastSentAt, &sentSince)
	if err != nil {
		return emails.SendHistory{}, fmt.Errorf("sent history: %w", err)
	}
	return emails.SendHistory{LastSentAt: timeFrom(lastSentAt), SentSince: sentSince}, nil
}

func (r emailRepository) collect(ctx context.Context, what, query string, args ...any) ([]domain.Email, error) {
	rows, err := r.unit.query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", what, err)
	}
	defer rows.Close() //nolint:errcheck // read cursor; rows.Err below reports failures
	var found []domain.Email
	for rows.Next() {
		email, err := scanEmail(rows)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", what, err)
		}
		found = append(found, email)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%s: %w", what, err)
	}
	return found, nil
}

func encodeAddresses(email domain.Email) (toAddresses, ccAddresses string, err error) {
	if toAddresses, err = encodeList(email.To); err != nil {
		return "", "", err
	}
	if ccAddresses, err = encodeList(email.Cc); err != nil {
		return "", "", err
	}
	return toAddresses, ccAddresses, nil
}

func scanEmail(row scanner) (domain.Email, error) {
	var (
		email                                                         domain.Email
		jobID, companySlug, approvedBy, approvedAt, sentAt, messageID sql.NullString
		deliveryError                                                 sql.NullString
		toAddresses, ccAddresses, kind, status, createdAt             string
	)
	if err := row.Scan(&email.ID, &jobID, &companySlug, &toAddresses, &ccAddresses, &email.Subject, &email.Body, &kind, &status,
		&email.CreatedBy, &createdAt, &approvedBy, &approvedAt, &sentAt, &messageID, &deliveryError, &email.Attempts, &email.Version); err != nil {
		return domain.Email{}, err //nolint:wrapcheck // callers distinguish sql.ErrNoRows and add the context themselves
	}
	parsedStatus, err := domain.ParseEmailStatus(status)
	if err != nil {
		return domain.Email{}, fmt.Errorf("email %s: %w", email.ID, err)
	}
	email.Status = parsedStatus
	email.Kind = domain.EmailKind(kind)
	email.JobID, email.CompanySlug = jobID.String, companySlug.String
	email.To, email.Cc = decodeList(toAddresses), decodeList(ccAddresses)
	email.CreatedAt = timeFrom(sql.NullString{String: createdAt, Valid: true})
	email.ApprovedBy, email.ApprovedAt = approvedBy.String, timeFrom(approvedAt)
	email.SentAt, email.MessageID, email.Error = timeFrom(sentAt), messageID.String, deliveryError.String
	return email, nil
}
