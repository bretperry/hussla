// First-run routes: a new setup code on request, the wizard's progress, the address's QR code, removing a passkey, and the mail setup the wizard and Settings save.
// In the app: the setup screen ("Print a new code"), the wizard's steps, "Scan this with your phone", passkey recovery, the mail step.
// Used by: server.go's route table.
//
// The mail credential goes in through PUT /api/mail/settings and never comes back out: GET
// answers whether one is stored, never what it is (mailsetup.Service keeps it in the secret store).

package httpapi

import (
	"net/http"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

func (server *api) setupNewCode(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	if err := server.deps.Auth.RequestSetupCode(r.Context(), caller); err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, okBody{OK: true})
	return nil
}

func (server *api) markWizardStep(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	if server.deps.Setup == nil {
		return &domain.ValidationError{Field: "step", Problem: "setup isn't available here"}
	}
	var input struct {
		Step  string `json:"step"`
		State string `json:"state"`
	}
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	wizard, err := server.deps.Setup.MarkStep(r.Context(), caller, input.Step, input.State)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, map[string]any{"steps": wizard.Steps, "finished": wizard.Finished})
	return nil
}

// addressQR is the ts.net address as a QR code, for the phone step.
func (server *api) addressQR(w http.ResponseWriter, _ *http.Request, _ auth.Principal) error {
	address := ""
	if server.deps.Setup != nil {
		address = server.deps.Setup.Address()
	}
	if address == "" {
		writeError(w, http.StatusNotFound, errorBody{Error: "this Hussla has no tailnet address yet"})
		return nil
	}
	svg, err := qrSVG(address)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(svg))
	return nil
}

func (server *api) removePasskey(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	if err := server.deps.Auth.RemovePasskey(r.Context(), caller, r.PathValue("passkeyId")); err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, okBody{OK: true})
	return nil
}

type mailRegionJSON struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type mailProviderJSON struct {
	ID            string           `json:"id"`
	Label         string           `json:"label"`
	Kind          string           `json:"kind"`
	NeedsServer   bool             `json:"needsServer"`
	NeedsDomain   bool             `json:"needsDomain"`
	UsernameHint  string           `json:"usernameHint"`
	SecretLabel   string           `json:"secretLabel"`
	HelpSteps     []string         `json:"helpSteps"`
	CredentialURL string           `json:"credentialUrl"`
	DocsURL       string           `json:"docsUrl"`
	Warning       string           `json:"warning"`
	Regions       []mailRegionJSON `json:"regions"`
}

func (server *api) mailProviders(w http.ResponseWriter, _ *http.Request, _ auth.Principal) error {
	catalog := config.MailProviders()
	encoded := make([]mailProviderJSON, 0, len(catalog))
	for _, provider := range catalog {
		kind := "smtp"
		if provider.Kind == config.MailProviderAPI {
			kind = "api"
		}
		regions := make([]mailRegionJSON, 0, len(provider.Regions))
		for _, region := range provider.Regions {
			regions = append(regions, mailRegionJSON{ID: region.ID, Label: region.Label})
		}
		steps := provider.HelpSteps
		if steps == nil {
			steps = []string{}
		}
		encoded = append(encoded, mailProviderJSON{
			ID: provider.ID, Label: provider.Label, Kind: kind, NeedsServer: provider.ID == config.MailProviderOtherSMTP,
			NeedsDomain: provider.NeedsDomain, UsernameHint: provider.UsernameHint, SecretLabel: provider.SecretLabel,
			HelpSteps: steps, CredentialURL: provider.CredentialURL, DocsURL: provider.DocsURL, Warning: provider.Warning, Regions: regions,
		})
	}
	writeJSON(w, http.StatusOK, encoded)
	return nil
}

type mailSettingsJSON struct {
	Configured  bool   `json:"configured"`
	HasSecret   bool   `json:"hasSecret"`
	ProviderID  string `json:"providerId"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Security    string `json:"security"`
	Username    string `json:"username"`
	FromAddress string `json:"fromAddress"`
	FromName    string `json:"fromName"`
	Region      string `json:"region"`
	Domain      string `json:"domain"`
}

func mailViewToJSON(view mailsetup.View) mailSettingsJSON {
	settings := view.Settings
	return mailSettingsJSON{
		Configured: view.Configured, HasSecret: view.HasSecret, ProviderID: settings.ProviderID, Host: settings.Host, Port: settings.Port,
		Security: settings.Security, Username: settings.Username, FromAddress: settings.FromAddress, FromName: settings.FromName,
		Region: settings.Region, Domain: settings.Domain,
	}
}

func (server *api) mailSettings(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	if server.deps.MailSetup == nil {
		writeJSON(w, http.StatusOK, mailSettingsJSON{})
		return nil
	}
	view, err := server.deps.MailSetup.View(r.Context())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, mailViewToJSON(view))
	return nil
}

func (server *api) saveMailSettings(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	if server.deps.MailSetup == nil {
		return mailsetup.ErrNotConfigured
	}
	var input struct {
		mailsetup.Settings
		// Secret is the password or API key; absent keeps the stored one (same provider only).
		Secret *string `json:"secret"`
	}
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	save := mailsetup.SaveInput{Settings: input.Settings}
	if input.Secret != nil {
		secret := mailsetup.NewSecret(*input.Secret)
		save.Secret = &secret
	}
	view, err := server.deps.MailSetup.Save(r.Context(), save, caller.Actor())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, mailViewToJSON(view))
	return nil
}
