// The companies table: the companies repository, a slug, a name and one JSON cell for the rest.
// In the app: the company page, the companies table and compare view, every research agent's write.
// Used by: the units of work in store.go (Tx.Companies).
// Uses: internal/app/wire (the API-named JSON of a company), internal/app/companies (the port).
//
// Same shape as jobs.go: slug, name and updatedAt are columns, everything else (extras included)
// is API-named JSON in `data`, and `writers` holds the owner-written field names.

package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/bretperry/hussla/internal/app/companies"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

const companySelect = `SELECT slug, name, data, writers, updatedAt FROM companies`

type companyRepository struct{ unit *unit }

var _ companies.Repository = companyRepository{}

func (u *unit) Companies() companies.Repository { return companyRepository{unit: u} }

func (r companyRepository) Get(ctx context.Context, slug string) (domain.Company, error) {
	company, err := scanCompany(r.unit.queryRow(ctx, companySelect+` WHERE slug = ?`, slug))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Company{}, storeerr.ErrNotFound
	}
	if err != nil {
		return domain.Company{}, fmt.Errorf("get company %s: %w", slug, err)
	}
	return company, nil
}

func (r companyRepository) List(ctx context.Context) ([]domain.Company, error) {
	rows, err := r.unit.query(ctx, companySelect+` ORDER BY name COLLATE NOCASE, slug`)
	if err != nil {
		return nil, fmt.Errorf("list companies: %w", err)
	}
	defer rows.Close() //nolint:errcheck // closing a read-only handle loses nothing
	var found []domain.Company
	for rows.Next() {
		company, err := scanCompany(rows)
		if err != nil {
			return nil, fmt.Errorf("list companies: %w", err)
		}
		found = append(found, company)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list companies: %w", err)
	}
	return found, nil
}

func (r companyRepository) Create(ctx context.Context, company domain.Company) error {
	data, err := companyData(company)
	if err != nil {
		return err
	}
	_, err = r.unit.exec(ctx, `INSERT INTO companies (slug, name, data, writers, updatedAt) VALUES (?, ?, ?, ?, ?)`,
		company.Slug, company.Name, data, wire.EncodeWriters(company.Writers), requiredTimeArg(company.UpdatedAt))
	if isUniqueViolation(err) {
		return storeerr.ErrExists
	}
	if err != nil {
		return fmt.Errorf("create company %s: %w", company.Slug, err)
	}
	return nil
}

func (r companyRepository) Update(ctx context.Context, company domain.Company) error {
	data, err := companyData(company)
	if err != nil {
		return err
	}
	result, err := r.unit.exec(ctx, `UPDATE companies SET name = ?, data = ?, writers = ?, updatedAt = ? WHERE slug = ?`,
		company.Name, data, wire.EncodeWriters(company.Writers), requiredTimeArg(company.UpdatedAt), company.Slug)
	if err != nil {
		return fmt.Errorf("update company %s: %w", company.Slug, err)
	}
	return requireRow(result, "update company "+company.Slug)
}

// companyData is the JSON for the `data` cell: everything but the columns.
func companyData(company domain.Company) (string, error) {
	object := wire.CompanyObject(company)
	for _, key := range []string{"slug", "name", "updatedAt"} {
		delete(object, key)
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return "", fmt.Errorf("encode company %s: %w", company.Slug, err)
	}
	return string(encoded), nil
}

func scanCompany(row scanner) (domain.Company, error) {
	var slug, name, data, writers, updatedAt string
	if err := row.Scan(&slug, &name, &data, &writers, &updatedAt); err != nil {
		return domain.Company{}, err //nolint:wrapcheck // callers distinguish sql.ErrNoRows and add the context themselves
	}
	object, err := wire.ParseObject([]byte(defaultObject(data)))
	if err != nil {
		return domain.Company{}, fmt.Errorf("company %s has damaged data: %w", slug, err)
	}
	columns := columnSet{object: object}
	columns.text("slug", slug)
	columns.text("name", name)
	columns.text("updatedAt", updatedAt)
	company, _ := wire.DecodeCompany(object) // warnings: a stored value that no longer reads is skipped, not fatal
	company.Writers, err = wire.DecodeWriters(writers)
	if err != nil {
		return domain.Company{}, fmt.Errorf("company %s: %w", slug, err)
	}
	return company, nil
}
