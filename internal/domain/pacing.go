// Send pacing: may the outbox send one more approved email right now, and if not, when next.
// In the app: the outbox dispatcher (Phase 4) asks before every send; GET /api/mail shows the same answer.
// Used by: the outbox use-case; config/mail.go holds the default knobs.
//
// Three rules, all in the owner's time zone: only inside the daily window hours, never more than
// the daily cap per local calendar day, and never sooner than the minimum gap plus this gap's
// jitter after the last send. The jitter is random, so the dispatcher draws it (once per gap,
// after each send) and passes it in: the rule stays a pure function of its inputs.

package domain

import (
	"time"

	"github.com/bretperry/hussla/internal/config"
)

// PacingRules are the knobs one pacing decision uses.
type PacingRules struct {
	MinGap          time.Duration
	Jitter          time.Duration // the extra wait drawn for the current gap, 0 to config.MailMaxJitter
	DailyLimit      int
	WindowStartHour int // first local hour a send may start in
	WindowEndHour   int // sends stop at the start of this local hour; 24 means midnight
	Location        *time.Location
}

// DefaultPacingRules are the config knobs in a given zone (the caller loads the zone; loading reads tz data, which is I/O).
func DefaultPacingRules(location *time.Location) PacingRules {
	return PacingRules{
		MinGap:          config.MailMinGap,
		DailyLimit:      config.MailDailyLimit,
		WindowStartHour: config.MailWindowStartHour,
		WindowEndHour:   config.MailWindowEndHour,
		Location:        location,
	}
}

// Validate refuses rules that could never allow a send or that make no sense.
func (rules PacingRules) Validate() error {
	switch {
	case rules.Location == nil:
		return invalid("timeZone", "is required")
	case rules.MinGap < 0 || rules.Jitter < 0:
		return invalid("minGap", "can't be negative")
	case rules.DailyLimit < 0:
		return invalid("dailyLimit", "can't be negative")
	case rules.WindowStartHour < 0 || rules.WindowEndHour > 24 || rules.WindowStartHour >= rules.WindowEndHour:
		return invalid("hours", "the window must start before it ends, within 0-24")
	}
	return nil
}

// PacingVerdict is the answer to "may we send now".
type PacingVerdict int

const (
	PacingSendNow PacingVerdict = iota
	PacingOutsideWindow
	PacingDailyLimitReached
	PacingTooSoon
	PacingRulesInvalid
)

var pacingVerdictNames = []string{"send-now", "outside-window", "daily-limit-reached", "too-soon", "rules-invalid"}

func (verdict PacingVerdict) String() string { return enumName(pacingVerdictNames, verdict) }

// PacingDecision is the verdict and, when it isn't PacingSendNow, the earliest moment worth asking
// again. NotBefore is a hint for sleeping, not a promise: the count or the rules may change by then.
type PacingDecision struct {
	Verdict   PacingVerdict
	NotBefore time.Time
}

// Allowed is true when an email may go now.
func (decision PacingDecision) Allowed() bool { return decision.Verdict == PacingSendNow }

// CanSendNow decides whether one more email may be sent at `now`. lastSentAt is the most recent
// send (zero for never; one after `now` counts as now); sentToday is how many were sent since
// StartOfLocalDay(now), counted from the sent rows, never from memory.
func CanSendNow(now, lastSentAt time.Time, sentToday int, rules PacingRules) PacingDecision {
	if err := rules.Validate(); err != nil {
		return PacingDecision{Verdict: PacingRulesInvalid}
	}
	if !rules.inWindow(now) {
		return PacingDecision{Verdict: PacingOutsideWindow, NotBefore: rules.nextWindowStart(now)}
	}
	if sentToday >= rules.DailyLimit {
		return PacingDecision{Verdict: PacingDailyLimitReached, NotBefore: rules.windowStartOnDay(now, 1)}
	}
	if !lastSentAt.IsZero() {
		// A send stamped after `now` means the clock jumped back: it counts as just now. Nothing
		// goes out until the clock passes it plus the gap, and NotBefore stays one gap ahead
		// instead of pointing hours into a future the clock may never reach on schedule.
		if lastSentAt.After(now) {
			lastSentAt = now
		}
		earliest := lastSentAt.Add(rules.MinGap + rules.Jitter)
		if now.Before(earliest) {
			if !rules.inWindow(earliest) {
				earliest = rules.nextWindowStart(earliest)
			}
			return PacingDecision{Verdict: PacingTooSoon, NotBefore: earliest}
		}
	}
	return PacingDecision{Verdict: PacingSendNow}
}

// StartOfLocalDay is local midnight of the day `moment` falls on in `location`; the daily cap counts sends from here.
func StartOfLocalDay(moment time.Time, location *time.Location) time.Time {
	local := moment.In(location)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
}

// inWindow is true when the local hour at `moment` is within [start, end).
func (rules PacingRules) inWindow(moment time.Time) bool {
	hour := moment.In(rules.Location).Hour()
	return hour >= rules.WindowStartHour && hour < rules.WindowEndHour
}

// windowStartOnDay is the window's opening on the local day `daysAhead` after the one `moment` falls on.
func (rules PacingRules) windowStartOnDay(moment time.Time, daysAhead int) time.Time {
	local := moment.In(rules.Location)
	return time.Date(local.Year(), local.Month(), local.Day()+daysAhead, rules.WindowStartHour, 0, 0, 0, rules.Location)
}

// nextWindowStart is the next opening of the window strictly after `moment` (today's if it is
// still ahead, else tomorrow's).
func (rules PacingRules) nextWindowStart(moment time.Time) time.Time {
	today := rules.windowStartOnDay(moment, 0)
	if today.After(moment) {
		return today
	}
	return rules.windowStartOnDay(moment, 1)
}
