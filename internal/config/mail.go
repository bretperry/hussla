// Outbox pacing knobs: how fast, how often, and when approved email may leave.
// In the app: the outbox dispatcher checks domain.CanSendNow with these before every send.
// Used by: internal/domain (DefaultPacingRules, Email.MarkSendFailed), the outbox use-case (Phase 4), GET /api/mail.
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
