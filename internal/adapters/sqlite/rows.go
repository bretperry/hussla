// Row helpers shared by the repositories: nullable columns, JSON cells and affected-row checks.
// In the app: nothing user-visible; it keeps each repository file about its own table.
// Used by: every repository file in this package.
// Uses: internal/app/wire (Object), internal/app/storeerr.

package sqlite

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/wire"
)

// intArg is a nullable number as a bind value.
func intArg(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

// defaultObject treats an empty `data` cell like the prototype's default.
func defaultObject(data string) string {
	if data == "" {
		return "{}"
	}
	return data
}

// requireRow turns "no row changed" into ErrNotFound.
func requireRow(result sql.Result, what string) error {
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	if changed == 0 {
		return storeerr.ErrNotFound
	}
	return nil
}

// columnSet writes a row's column values into the object its JSON cell was read into; the columns win.
type columnSet struct{ object wire.Object }

func (c columnSet) text(key, value string) { c.object[key] = quoted(value) }

// nullText sets a nullable text column; NULL leaves the key out, as if the field was never set.
func (c columnSet) nullText(key string, value sql.NullString) {
	if value.Valid {
		c.object[key] = quoted(value.String)
	} else {
		delete(c.object, key)
	}
}

func (c columnSet) number(key string, value sql.NullInt64) {
	if value.Valid {
		c.object[key] = json.RawMessage(fmt.Sprint(value.Int64))
	} else {
		delete(c.object, key)
	}
}

func quoted(value string) json.RawMessage {
	encoded, _ := json.Marshal(value) // text always encodes
	return encoded
}
