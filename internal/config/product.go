// Customer-facing product copy: the one place the product's name and pitch live.
// In the app: the page header and titles (the UI reads them from GET /api/me), the setup
// wizard, and the subject of the test email.
// Used by: internal/app (setup, mail test), the HTTP layer's /api/me.

package config

// ProductName is the name shown to the owner everywhere in the app.
const ProductName = "Hussla"

// ProductTagline is the one-line pitch under the name on the setup screen.
const ProductTagline = "Your job search, in one place"
