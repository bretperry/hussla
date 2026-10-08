// Tests for send pacing: the window, the cap and the gap at known moments (DST days included), and properties over simulated days of sending.

package domain_test

import (
	"testing"
	"time"
	_ "time/tzdata" // the tests' zone data, so they don't depend on the machine's

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

func newYork(t interface{ Fatalf(string, ...any) }) *time.Location {
	location, err := time.LoadLocation(config.MailTimeZone)
	if err != nil {
		t.Fatalf("load %s: %v", config.MailTimeZone, err)
	}
	return location
}

func TestCanSendNowAtKnownMoments(t *testing.T) {
	location := newYork(t)
	rules := domain.DefaultPacingRules(location)
	at := func(month time.Month, day, hour, minute int) time.Time {
		return time.Date(2026, month, day, hour, minute, 0, 0, location)
	}
	cases := []struct {
		name          string
		now           time.Time
		lastSentAt    time.Time
		sentToday     int
		jitter        time.Duration
		wantVerdict   domain.PacingVerdict
		wantNotBefore time.Time
	}{
		{"inside the window, nothing sent", at(10, 7, 9, 0), time.Time{}, 0, 0, domain.PacingSendNow, time.Time{}},
		{"before the window opens", at(10, 7, 7, 59), time.Time{}, 0, 0, domain.PacingOutsideWindow, at(10, 7, 8, 0)},
		{"at the window's end hour", at(10, 7, 18, 0), time.Time{}, 0, 0, domain.PacingOutsideWindow, at(10, 8, 8, 0)},
		{"last minute of the window", at(10, 7, 17, 59), time.Time{}, 0, 0, domain.PacingSendNow, time.Time{}},
		{"cap reached", at(10, 7, 12, 0), time.Time{}, config.MailDailyLimit, 0, domain.PacingDailyLimitReached, at(10, 8, 8, 0)},
		{"one under the cap", at(10, 7, 12, 0), time.Time{}, config.MailDailyLimit - 1, 0, domain.PacingSendNow, time.Time{}},
		{"inside the gap", at(10, 7, 12, 3), at(10, 7, 12, 0), 1, 0, domain.PacingTooSoon, at(10, 7, 12, 4)},
		{"gap plus jitter", at(10, 7, 12, 5), at(10, 7, 12, 0), 1, 2 * time.Minute, domain.PacingTooSoon, at(10, 7, 12, 6)},
		{"exactly the gap", at(10, 7, 12, 4), at(10, 7, 12, 0), 1, 0, domain.PacingSendNow, time.Time{}},
		{"last send in the future counts as now", at(10, 7, 12, 0), at(10, 7, 15, 0), 1, 0, domain.PacingTooSoon, at(10, 7, 12, 4)},
		{"gap ends after the window", at(10, 7, 17, 58), at(10, 7, 17, 57), 1, 0, domain.PacingTooSoon, at(10, 8, 8, 0)},
		// US DST starts 2026-03-08 at 02:00 and ends 2026-11-01 at 02:00; the window is local hours either way.
		{"DST start day, 8am local", at(3, 8, 8, 0), time.Time{}, 0, 0, domain.PacingSendNow, time.Time{}},
		{"DST end day, before 8am local", at(11, 1, 7, 30), time.Time{}, 0, 0, domain.PacingOutsideWindow, at(11, 1, 8, 0)},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			rules := rules
			rules.Jitter = testCase.jitter
			decision := domain.CanSendNow(testCase.now, testCase.lastSentAt, testCase.sentToday, rules)
			if decision.Verdict != testCase.wantVerdict || !decision.NotBefore.Equal(testCase.wantNotBefore) {
				t.Fatalf("got %v not before %v, want %v not before %v",
					decision.Verdict, decision.NotBefore, testCase.wantVerdict, testCase.wantNotBefore)
			}
		})
	}
}

func TestPacingRulesValidate(t *testing.T) {
	location := newYork(t)
	broken := map[string]domain.PacingRules{
		"no zone":       {WindowStartHour: 8, WindowEndHour: 18, DailyLimit: 1},
		"empty window":  {WindowStartHour: 9, WindowEndHour: 9, DailyLimit: 1, Location: location},
		"past midnight": {WindowStartHour: 8, WindowEndHour: 25, DailyLimit: 1, Location: location},
		"negative gap":  {MinGap: -time.Minute, WindowStartHour: 8, WindowEndHour: 18, DailyLimit: 1, Location: location},
	}
	for name, rules := range broken {
		if rules.Validate() == nil {
			t.Errorf("%s: Validate passed", name)
		}
		if domain.CanSendNow(time.Now(), time.Time{}, 0, rules).Allowed() {
			t.Errorf("%s: CanSendNow allowed a send under invalid rules", name)
		}
	}
	if err := domain.DefaultPacingRules(location).Validate(); err != nil {
		t.Errorf("the default knobs don't validate: %v", err)
	}
}

func TestStartOfLocalDay(t *testing.T) {
	location := newYork(t)
	// 03:30 UTC on Oct 8 is still Oct 7 in New York (UTC-4).
	moment := time.Date(2026, 10, 8, 3, 30, 0, 0, time.UTC)
	want := time.Date(2026, 10, 7, 0, 0, 0, 0, location)
	if got := domain.StartOfLocalDay(moment, location); !got.Equal(want) {
		t.Fatalf("StartOfLocalDay = %v, want %v", got, want)
	}
}

// simulatedSend is one send the simulated dispatcher made, with the jitter it drew for the gap after it.
type simulatedSend struct {
	at     time.Time
	jitter time.Duration
}

// Property: a dispatcher that asks before every send, at random moments over a few days, never
// sends twice inside the gap (plus that gap's jitter), never more than the cap in one local day,
// and never outside the window hours. Zones and knobs are drawn too, including a DST zone.
func TestPacingNeverBreaksItsRules(t *testing.T) {
	zones := []*time.Location{time.UTC, newYork(t), time.FixedZone("UTC+13", 13*3600), time.FixedZone("UTC-9:30", -(9*3600 + 1800))}
	rapid.Check(t, func(t *rapid.T) {
		start := rapid.IntRange(0, 22).Draw(t, "windowStart")
		rules := domain.PacingRules{
			MinGap:          time.Duration(rapid.IntRange(0, 60).Draw(t, "gapMinutes")) * time.Minute,
			DailyLimit:      rapid.IntRange(0, 30).Draw(t, "dailyLimit"),
			WindowStartHour: start,
			WindowEndHour:   rapid.IntRange(start+1, 24).Draw(t, "windowEnd"),
			Location:        rapid.SampledFrom(zones).Draw(t, "zone"),
		}
		maxJitter := time.Duration(rapid.IntRange(0, 10).Draw(t, "maxJitterMinutes")) * time.Minute
		// Start somewhere around a DST change in either direction.
		now := time.Date(2026, rapid.SampledFrom([]time.Month{3, 11}).Draw(t, "month"), rapid.IntRange(1, 9).Draw(t, "day"), 0, 0, 0, 0, time.UTC)
		var sends []simulatedSend
		for range rapid.IntRange(1, 400).Draw(t, "asks") {
			now = now.Add(time.Duration(rapid.IntRange(0, 90).Draw(t, "stepMinutes")) * time.Minute)
			var lastSentAt time.Time
			rules.Jitter = 0
			if len(sends) > 0 {
				lastSentAt, rules.Jitter = sends[len(sends)-1].at, sends[len(sends)-1].jitter
			}
			dayStart := domain.StartOfLocalDay(now, rules.Location)
			sentToday := 0
			for _, send := range sends {
				if !send.at.Before(dayStart) {
					sentToday++
				}
			}
			decision := domain.CanSendNow(now, lastSentAt, sentToday, rules)
			if !decision.Allowed() {
				if !decision.NotBefore.After(now) {
					t.Fatalf("refused at %v (%v) but NotBefore %v isn't later", now, decision.Verdict, decision.NotBefore)
				}
				continue
			}
			jitter := time.Duration(rapid.Int64Range(0, int64(maxJitter)).Draw(t, "jitter"))
			sends = append(sends, simulatedSend{at: now, jitter: jitter})
		}
		perDay := map[time.Time]int{}
		for index, send := range sends {
			local := send.at.In(rules.Location)
			if local.Hour() < rules.WindowStartHour || local.Hour() >= rules.WindowEndHour {
				t.Fatalf("sent at %v, outside %d-%d", local, rules.WindowStartHour, rules.WindowEndHour)
			}
			day := domain.StartOfLocalDay(send.at, rules.Location)
			perDay[day]++
			if perDay[day] > rules.DailyLimit {
				t.Fatalf("%d sends on %v, over the cap of %d", perDay[day], day, rules.DailyLimit)
			}
			if index > 0 {
				previous := sends[index-1]
				if gap := send.at.Sub(previous.at); gap < rules.MinGap+previous.jitter {
					t.Fatalf("sends %v apart, inside the gap %v + jitter %v", gap, rules.MinGap, previous.jitter)
				}
			}
		}
	})
}

// Property: with the clock jumping backwards and forwards between asks (sleep, NTP, a wrong RTC),
// no send lands within gap + jitter of the latest send on record, no local day goes over the cap,
// and a refusal's NotBefore is later than now and, when only the gap is in the way, at most one
// gap + jitter ahead (a send stamped in the future counts as now).
func TestPacingSurvivesClockJumps(t *testing.T) {
	location := newYork(t)
	rapid.Check(t, func(t *rapid.T) {
		rules := domain.DefaultPacingRules(location)
		rules.WindowStartHour, rules.WindowEndHour = 0, 24 // jumps, not the window, are under test
		rules.DailyLimit = rapid.IntRange(1, 30).Draw(t, "dailyLimit")
		now := time.Date(2026, 10, 7, 12, 0, 0, 0, location)
		var sends []simulatedSend
		for range rapid.IntRange(1, 300).Draw(t, "asks") {
			now = now.Add(time.Duration(rapid.IntRange(-180, 120).Draw(t, "stepMinutes")) * time.Minute)
			latest := simulatedSend{}
			for _, send := range sends {
				if send.at.After(latest.at) {
					latest = send
				}
			}
			rules.Jitter = latest.jitter
			sentToday := 0
			for _, send := range sends {
				if !send.at.Before(domain.StartOfLocalDay(now, location)) {
					sentToday++
				}
			}
			decision := domain.CanSendNow(now, latest.at, sentToday, rules)
			if !decision.Allowed() {
				if !decision.NotBefore.After(now) {
					t.Fatalf("refused at %v but NotBefore %v isn't later", now, decision.NotBefore)
				}
				if decision.Verdict == domain.PacingTooSoon && decision.NotBefore.After(now.Add(rules.MinGap+rules.Jitter)) {
					t.Fatalf("NotBefore %v is more than one gap after %v", decision.NotBefore, now)
				}
				continue
			}
			if !latest.at.IsZero() && now.Before(latest.at.Add(rules.MinGap+latest.jitter)) {
				t.Fatalf("sent at %v, inside the gap after the latest send %v", now, latest.at)
			}
			sends = append(sends, simulatedSend{at: now, jitter: time.Duration(rapid.IntRange(0, 180).Draw(t, "jitterSeconds")) * time.Second})
		}
		perDay := map[time.Time]int{}
		for _, send := range sends {
			day := domain.StartOfLocalDay(send.at, location)
			if perDay[day]++; perDay[day] > rules.DailyLimit {
				t.Fatalf("%d sends on %v, over the cap of %d", perDay[day], day, rules.DailyLimit)
			}
		}
	})
}
