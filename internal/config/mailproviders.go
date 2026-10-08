// The mail provider catalog: every way Hussla can send email, with the settings and steps for each.
// In the app: the mail setup screen (pick a provider, follow its steps), the sender the outbox uses, the daily cap.
// Used by: internal/app/mailsetup (validates a choice), internal/adapters/mailfactory (builds the sender).
// Uses: nothing; plain data.
//
// Each entry cites the provider's own documentation, checked 2026-10-08. Providers change these:
// when one stops working, re-check its doc link before touching code. Where a provider no longer
// takes a password over SMTP (personal Outlook.com), the entry says so in Warning and its help
// steps instead of pretending it works. DailyLimit is the provider's published per-day sending
// cap, or 0 where it publishes none or it depends on the plan; the outbox sends at most the
// smaller of it and MailDailyLimit.

package config

// MailProviderKind is how a provider is reached: an SMTP server or an HTTP API.
type MailProviderKind int

const (
	MailProviderSMTP MailProviderKind = iota
	MailProviderAPI
)

// MailSecurity is how an SMTP connection is encrypted. There is no plaintext option on purpose:
// the password and every email would cross the network readable.
type MailSecurity int

const (
	// MailSecuritySTARTTLS connects in plain text and upgrades before anything else (usually port 587); the upgrade is required.
	MailSecuritySTARTTLS MailSecurity = iota
	// MailSecurityTLS is TLS from the first byte (usually port 465).
	MailSecurityTLS
)

// MailRegion is one of a provider's regional endpoints (an EU account lives on a different host).
type MailRegion struct {
	ID      string
	Label   string
	BaseURL string // API providers: scheme and host, no trailing slash
}

// MailProvider is one entry in the catalog.
type MailProvider struct {
	ID    string
	Label string
	Kind  MailProviderKind
	// SMTP providers.
	Host     string
	Port     int
	Security MailSecurity
	// API providers: the endpoint's scheme and host; Regions, when set, lists the alternatives (the first is the default).
	BaseURL string
	Regions []MailRegion
	// UsernameHint is what goes in the username box ("your full iCloud address").
	UsernameHint string
	// SecretLabel names the credential the owner pastes ("App-specific password", "API key").
	SecretLabel string
	// HelpSteps are the numbered steps the setup screen shows, in order.
	HelpSteps []string
	// CredentialURL is where the owner creates the app password or API key.
	CredentialURL string
	// DocsURL is the provider's own page these settings come from.
	DocsURL string
	// DailyLimit is the provider's published daily sending cap; 0 when none is published or it depends on the plan.
	DailyLimit int
	// NeedsDomain is true when the provider sends for a verified domain the owner names (Mailgun).
	NeedsDomain bool
	// Warning, when set, is shown before the steps: a known reason this provider may not work.
	Warning string
}

// MailProviderOtherSMTP is the catalog id of the custom-server entry: the owner types host, port and security.
const MailProviderOtherSMTP = "smtp"

// MailProviders returns the catalog in display order. A fresh copy each call, so no caller can edit it for another.
func MailProviders() []MailProvider {
	return []MailProvider{
		{
			// https://support.apple.com/en-us/102525 (server settings), https://support.apple.com/102198 (1,000 messages a day)
			ID: "icloud", Label: "iCloud Mail", Kind: MailProviderSMTP,
			Host: "smtp.mail.me.com", Port: 587, Security: MailSecuritySTARTTLS,
			UsernameHint: "Your full iCloud Mail address, like name@icloud.com",
			SecretLabel:  "App-specific password",
			HelpSteps: []string{
				"Turn on two-factor authentication for your Apple Account if it isn't already.",
				"Sign in at account.apple.com, open Sign-In and Security, then App-Specific Passwords.",
				`Create one named "Hussla" and paste it here. Your normal Apple Account password won't work.`,
				"Use your full iCloud Mail address as the username and as the From address.",
			},
			CredentialURL: "https://account.apple.com/account/manage",
			DocsURL:       "https://support.apple.com/en-us/102525",
			DailyLimit:    1000,
		},
		{
			// https://support.google.com/mail/answer/7126229 (smtp.gmail.com, 587 TLS / 465 SSL),
			// https://support.google.com/accounts/answer/185833 (app passwords need 2-Step Verification),
			// https://support.google.com/mail/answer/22839 (limits "after more than 500 emails sent in a day")
			ID: "gmail", Label: "Gmail", Kind: MailProviderSMTP,
			Host: "smtp.gmail.com", Port: 587, Security: MailSecuritySTARTTLS,
			UsernameHint: "Your full Gmail address",
			SecretLabel:  "App password",
			HelpSteps: []string{
				"Turn on 2-Step Verification for your Google Account (app passwords need it).",
				"Open myaccount.google.com/apppasswords and create an app password named \"Hussla\".",
				"Paste the 16-letter password here (spaces don't matter). Your normal Google password won't work.",
				"Google Workspace: your admin may have turned app passwords off; ask them, or use Other SMTP with your organization's relay.",
			},
			CredentialURL: "https://myaccount.google.com/apppasswords",
			DocsURL:       "https://support.google.com/mail/answer/7126229",
			DailyLimit:    500,
		},
		{
			// https://support.microsoft.com/help/c5d65390-9676-4763-b41f-d7986499a90d (Outlook.com basic auth gone 2024-09-16),
			// https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835
			// (Microsoft 365: SMTP AUTH with a password off by default for existing tenants from late December 2026)
			ID: "outlook", Label: "Outlook / Microsoft 365", Kind: MailProviderSMTP,
			Host: "smtp.office365.com", Port: 587, Security: MailSecuritySTARTTLS,
			UsernameHint: "Your full work or school address",
			SecretLabel:  "Password or app password",
			Warning: "Personal Outlook.com, Hotmail and Live accounts can't send from apps with a password any more " +
				"(Microsoft turned it off on 16 September 2024) and Hussla doesn't sign in with Microsoft yet: pick another provider. " +
				"Microsoft 365 work accounts work only while your admin allows SMTP AUTH, which Microsoft switches off by default from late December 2026.",
			HelpSteps: []string{
				"Personal Outlook.com / Hotmail: this won't work. Use iCloud, Gmail, Fastmail or an API provider instead.",
				"Microsoft 365: ask your admin to enable Authenticated SMTP (SMTP AUTH) for your mailbox.",
				"If your account uses multi-factor sign-in, create an app password if your organization allows them; otherwise use your password.",
				"Use your full address as the username and as the From address.",
			},
			CredentialURL: "https://mysignins.microsoft.com/security-info",
			DocsURL:       "https://support.microsoft.com/help/c5d65390-9676-4763-b41f-d7986499a90d",
		},
		{
			// https://help.yahoo.com/kb/SLN4724.html (smtp.mail.yahoo.com, 465 or 587, SSL required, app password)
			ID: "yahoo", Label: "Yahoo Mail", Kind: MailProviderSMTP,
			Host: "smtp.mail.yahoo.com", Port: 465, Security: MailSecurityTLS,
			UsernameHint: "Your full Yahoo address",
			SecretLabel:  "App password",
			HelpSteps: []string{
				"Sign in at login.yahoo.com, open Account security, then Generate app password.",
				`Name it "Hussla" and paste the password here. Your normal Yahoo password won't work.`,
			},
			CredentialURL: "https://login.yahoo.com/account/security",
			DocsURL:       "https://help.yahoo.com/kb/SLN4724.html",
		},
		{
			// https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports
			// (smtp.fastmail.com, 465 SSL/TLS or 587 STARTTLS, app password required)
			ID: "fastmail", Label: "Fastmail", Kind: MailProviderSMTP,
			Host: "smtp.fastmail.com", Port: 465, Security: MailSecurityTLS,
			UsernameHint: "Your full Fastmail address",
			SecretLabel:  "App password",
			HelpSteps: []string{
				"In Fastmail open Settings, then Privacy & Security, then Manage app passwords.",
				`Create one with SMTP access named "Hussla" and paste it here. Your normal Fastmail password won't work.`,
			},
			CredentialURL: "https://app.fastmail.com/settings/security/apps",
			DocsURL:       "https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports",
		},
		{
			// https://www.zoho.com/mail/help/zoho-smtp.html (smtp.zoho.com; paid organizations smtppro.zoho.com; 465 SSL or 587 TLS)
			ID: "zoho", Label: "Zoho Mail", Kind: MailProviderSMTP,
			Host: "smtp.zoho.com", Port: 587, Security: MailSecuritySTARTTLS,
			UsernameHint: "Your full Zoho address",
			SecretLabel:  "Password or application-specific password",
			HelpSteps: []string{
				"Personal and free-organization accounts use smtp.zoho.com; paid organizations with their own domain use smtppro.zoho.com (change the server).",
				"Accounts outside the US datacenter use a different server: Zoho shows yours under Settings, Mail Accounts, Server Configuration Details.",
				"With two-factor authentication on, create an application-specific password and paste it here.",
				"The From address must be your Zoho address or one of its aliases.",
			},
			CredentialURL: "https://accounts.zoho.com/home#security/app_password",
			DocsURL:       "https://www.zoho.com/mail/help/zoho-smtp.html",
		},
		{
			ID: MailProviderOtherSMTP, Label: "Other SMTP server", Kind: MailProviderSMTP,
			Port: 587, Security: MailSecuritySTARTTLS,
			UsernameHint: "Usually your full email address",
			SecretLabel:  "Password",
			HelpSteps: []string{
				"Find your provider's outgoing (SMTP) server name and port in its help pages.",
				"Port 587 uses STARTTLS; port 465 uses TLS. Hussla never sends without encryption.",
				"If your provider offers app passwords, use one instead of your main password.",
			},
		},
		{
			// https://resend.com/docs/api-reference/emails/send-email (POST https://api.resend.com/emails, Bearer key,
			// Idempotency-Key header kept 24 hours: https://resend.com/docs/dashboard/emails/idempotency-keys)
			ID: "resend", Label: "Resend", Kind: MailProviderAPI,
			BaseURL:      "https://api.resend.com",
			UsernameHint: "No username needed",
			SecretLabel:  "API key (starts with re_)",
			HelpSteps: []string{
				"Add and verify your sending domain in Resend (Domains).",
				"Create an API key with Sending access and paste it here.",
				"Use an address on the verified domain as the From address.",
			},
			CredentialURL: "https://resend.com/api-keys",
			DocsURL:       "https://resend.com/docs/api-reference/emails/send-email",
		},
		{
			// https://postmarkapp.com/developer/api/email-api (POST https://api.postmarkapp.com/email, X-Postmark-Server-Token)
			ID: "postmark", Label: "Postmark", Kind: MailProviderAPI,
			BaseURL:      "https://api.postmarkapp.com",
			UsernameHint: "No username needed",
			SecretLabel:  "Server API token",
			HelpSteps: []string{
				"Confirm a Sender Signature (or verify your domain) for the From address in Postmark.",
				"Open your server, then API Tokens, and paste the Server API token here.",
			},
			CredentialURL: "https://account.postmarkapp.com/servers",
			DocsURL:       "https://postmarkapp.com/developer/api/email-api",
		},
		{
			// https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
			// (POST /v3/mail/send, Bearer key, 202 Accepted; EU subusers use api.eu.sendgrid.com)
			ID: "sendgrid", Label: "SendGrid", Kind: MailProviderAPI,
			BaseURL: "https://api.sendgrid.com",
			Regions: []MailRegion{
				{ID: "global", Label: "Global", BaseURL: "https://api.sendgrid.com"},
				{ID: "eu", Label: "EU subuser", BaseURL: "https://api.eu.sendgrid.com"},
			},
			UsernameHint: "No username needed",
			SecretLabel:  "API key (starts with SG.)",
			HelpSteps: []string{
				"Verify a single sender or authenticate your domain in SendGrid (Sender Authentication).",
				"Create an API key with Mail Send access and paste it here.",
			},
			CredentialURL: "https://app.sendgrid.com/settings/api_keys",
			DocsURL:       "https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send",
		},
		{
			// https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages
			// (POST /v3/{domain}/messages, basic auth "api" + key, multipart form; EU accounts use api.eu.mailgun.net)
			ID: "mailgun", Label: "Mailgun", Kind: MailProviderAPI,
			BaseURL: "https://api.mailgun.net",
			Regions: []MailRegion{
				{ID: "us", Label: "US", BaseURL: "https://api.mailgun.net"},
				{ID: "eu", Label: "EU", BaseURL: "https://api.eu.mailgun.net"},
			},
			UsernameHint: "No username needed",
			SecretLabel:  "Sending API key",
			NeedsDomain:  true,
			HelpSteps: []string{
				"Add and verify your sending domain in Mailgun, and note whether the account is in the US or EU region.",
				"Create a sending API key for that domain and paste it here.",
				"Type the sending domain (like mg.example.com) and use an address on it as the From address.",
			},
			CredentialURL: "https://app.mailgun.com/settings/api_security",
			DocsURL:       "https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages",
		},
	}
}

// FindMailProvider returns the catalog entry with that id.
func FindMailProvider(id string) (MailProvider, bool) {
	for _, provider := range MailProviders() {
		if provider.ID == id {
			return provider, true
		}
	}
	return MailProvider{}, false
}
