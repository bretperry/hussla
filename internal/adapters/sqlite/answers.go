// The answers table: saved replies to application-form questions.
// In the app: the Answers page and every agent filling a form.
// Used by: the units of work in store.go (Tx.Answers).
// Uses: internal/app/answers (the port), internal/app/wire (writers).

package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/bretperry/hussla/internal/app/answers"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

const answerSelect = `SELECT id, question, answer, jobIds, writers, createdAt, answeredAt FROM answers`

type answerRepository struct{ unit *unit }

var _ answers.Repository = answerRepository{}

func (u *unit) Answers() answers.Repository { return answerRepository{unit: u} }

func (r answerRepository) Get(ctx context.Context, id string) (domain.Answer, error) {
	answer, err := scanAnswer(r.unit.queryRow(ctx, answerSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Answer{}, storeerr.ErrNotFound
	}
	if err != nil {
		return domain.Answer{}, fmt.Errorf("get answer %s: %w", id, err)
	}
	return answer, nil
}

func (r answerRepository) List(ctx context.Context) ([]domain.Answer, error) {
	rows, err := r.unit.query(ctx, answerSelect+` ORDER BY createdAt, id`)
	if err != nil {
		return nil, fmt.Errorf("list answers: %w", err)
	}
	defer rows.Close() //nolint:errcheck // read cursor; rows.Err below reports failures
	var found []domain.Answer
	for rows.Next() {
		answer, err := scanAnswer(rows)
		if err != nil {
			return nil, fmt.Errorf("list answers: %w", err)
		}
		found = append(found, answer)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list answers: %w", err)
	}
	return found, nil
}

func (r answerRepository) Create(ctx context.Context, answer domain.Answer) error {
	jobIDs, err := encodeList(answer.JobIDs)
	if err != nil {
		return err
	}
	_, err = r.unit.exec(ctx, `INSERT INTO answers (id, question, answer, jobIds, writers, createdAt, answeredAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		answer.ID, answer.Question, answer.Answer, jobIDs, wire.EncodeWriters(answer.Writers),
		requiredTimeArg(answer.CreatedAt), timeArg(answer.AnsweredAt))
	if isUniqueViolation(err) {
		return storeerr.ErrExists
	}
	if err != nil {
		return fmt.Errorf("create answer %s: %w", answer.ID, err)
	}
	return nil
}

func (r answerRepository) Update(ctx context.Context, answer domain.Answer) error {
	jobIDs, err := encodeList(answer.JobIDs)
	if err != nil {
		return err
	}
	result, err := r.unit.exec(ctx, `UPDATE answers SET question = ?, answer = ?, jobIds = ?, writers = ?, createdAt = ?, answeredAt = ? WHERE id = ?`,
		answer.Question, answer.Answer, jobIDs, wire.EncodeWriters(answer.Writers),
		requiredTimeArg(answer.CreatedAt), timeArg(answer.AnsweredAt), answer.ID)
	if err != nil {
		return fmt.Errorf("update answer %s: %w", answer.ID, err)
	}
	return requireRow(result, "update answer "+answer.ID)
}

func (r answerRepository) Delete(ctx context.Context, id string) error {
	result, err := r.unit.exec(ctx, `DELETE FROM answers WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete answer %s: %w", id, err)
	}
	return requireRow(result, "delete answer "+id)
}

func scanAnswer(row scanner) (domain.Answer, error) {
	var (
		answer                     domain.Answer
		jobIDs, writers, createdAt string
		answeredAt                 sql.NullString
	)
	if err := row.Scan(&answer.ID, &answer.Question, &answer.Answer, &jobIDs, &writers, &createdAt, &answeredAt); err != nil {
		return domain.Answer{}, err //nolint:wrapcheck // callers distinguish sql.ErrNoRows and add the context themselves
	}
	answer.JobIDs = decodeList(jobIDs)
	answer.CreatedAt = timeFrom(sql.NullString{String: createdAt, Valid: true})
	answer.AnsweredAt = timeFrom(answeredAt)
	var err error
	answer.Writers, err = wire.DecodeWriters(writers)
	if err != nil {
		return domain.Answer{}, fmt.Errorf("answer %s: %w", answer.ID, err)
	}
	return answer, nil
}

// encodeList stores a text list as a JSON array, and nil as JSON null, so "no list" and "an empty list" come back as they went in.
func encodeList(list []string) (string, error) {
	encoded, err := json.Marshal(list)
	if err != nil {
		return "", fmt.Errorf("encode list: %w", err)
	}
	return string(encoded), nil
}

// decodeList reads a stored list of text: a JSON array ('[]' is the prototype's "none"), null for
// nil, or, for a cell typed by hand, comma-separated text, so no address is ever dropped on read.
func decodeList(cell string) []string {
	var list []string
	if err := json.Unmarshal([]byte(cell), &list); err == nil {
		return list
	}
	for _, part := range strings.FieldsFunc(cell, func(r rune) bool { return r == ',' || r == ';' }) {
		if part = strings.TrimSpace(part); part != "" {
			list = append(list, part)
		}
	}
	return list
}
