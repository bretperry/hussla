// Outbox pacing knobs: how fast, how often, and when approved email may leave.
// In the app: the outbox dispatcher checks domain.CanSendNow with these before every send.
// Used by: internal/domain (DefaultPacingRules, Email.MarkSendFailed), internal/app/outbox, the mail adapters (timeouts), GET /api/mail.
// Uses: time/tzdata (embedded zone data, so the zone loads anywhere).
//
// Why pace at all: a burst of near-identical follow-ups reads as a bot to a recruiter, and
// providers throttle or flag accounts that send in bursts. These are defaults; the setup
// wizard may later let the owner change the window and time zone.

package config

import (
	"time"

	// The zone database, built in: MailTimeZone must load on a distroless image or a Windows
	// laptop, where the system has none. Adds about 450 KB to the binary.
	_ "time/tzdata"
)

// MailMinGap is the shortest time between two sends.
const MailMinGap = 4 * time.Minute

// MailMaxJitter is the most random extra wait the dispatcher adds to MailMinGap after each send,
// so sends don't land on a visible schedule. The dispatcher draws it; the rule takes it as input.
const MailMaxJitter = 3 * time.Minute

// MailDailyLimit caps sends per local calendar day in MailTimeZone.
const MailDailyLimit = 25

// MailWindowStartHour and MailWindowEndHour bound the send window in MailTimeZone: a send may
// start at or after the start hour and before the end hour (8 and 18 mean 08:00 to 17:59).
const (
	MailWindowStartHour = 8
	MailWindowEndHour   = 18
)

// MailTimeZone is the IANA zone the window and the daily cap are counted in.
const MailTimeZone = "America/New_York"

// MailMaxAttempts is how many delivery attempts an approved email gets before it is marked failed.
const MailMaxAttempts = 3

// MailErrorMaxLength caps the stored delivery error, so a server's essay can't fill the outbox row.
const MailErrorMaxLength = 500

// MailPollInterval is the longest the dispatcher waits before looking at the queue and the clock
// again. Go's timers stop while a laptop sleeps, so a long wait could overshoot by the whole
// sleep; rechecking at least this often keeps the send window honest after a wake.
const MailPollInterval = time.Minute

// MailRetryDelay is how long the dispatcher waits after a send the provider definitely refused
// (nothing went out) before trying again, so a down server isn't hammered.
const MailRetryDelay = 5 * time.Minute

// MailConnectTimeout bounds connecting, the TLS handshake and each SMTP command before the message
// is handed over; a timeout here means nothing was sent, so the send is retried.
const MailConnectTimeout = 30 * time.Second

// MailDeliveryTimeout bounds handing over the message and waiting for the provider's answer. A
// timeout here may mean it went out, so the email is marked "may have been sent", never retried.
const MailDeliveryTimeout = 2 * time.Minute
