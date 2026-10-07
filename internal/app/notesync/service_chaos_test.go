// Fault injection (tier 2, testing.mdc) for notesync: one test per fault kind, plus a property over random fault scripts.
// In the app: nothing at runtime; runs in `go test` on every PR.
// Used by: go test.
// Uses: internal/testsupport/chaos (fault-script server, in-memory outbox), testing/synctest (virtual time), rapid.
//
// Each test drives the real use-case against a model of the far side and asserts the outcome:
// what the server holds, how many times a write applied, what is still queued. Remove a handler
// from service.go and its test goes red; that is the bar for a tier-2 test. Every test runs in a
// synctest bubble, where `time` is virtual: a 10-minute delay costs nothing, and a failure
// replays exactly (rapid prints the seed; pass it back with -rapid.seed).

package notesync_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"pgregory.net/rapid"

	"example.com/app/internal/app/notesync"
	"example.com/app/internal/config"
	"example.com/app/internal/domain"
	"example.com/app/internal/testsupport/chaos"
)

// devices numbers devices, so write ids are unique across them as real ones (UUIDs) are; the server dedupes on them.
var devices atomic.Int32

// device is one phone: its own disk and outbox faults, talking to a server. start() is a process (re)start.
type device struct {
	disk   *chaos.Disk
	faults *chaos.OutboxFaults
	skew   time.Duration
	name   string
	ids    int
}

func newDevice(skew time.Duration, faults chaos.OutboxFaults) *device {
	return &device{disk: &chaos.Disk{}, faults: &faults, skew: skew, name: fmt.Sprintf("d%d", devices.Add(1))}
}

func (d *device) start(remote notesync.Remote) *notesync.Service {
	return notesync.New(notesync.Deps{
		Outbox:     chaos.NewOutbox(d.disk, d.faults),
		Remote:     remote,
		Clock:      chaos.DeviceClock{SkewBy: d.skew},
		NewWriteID: func() string { d.ids++; return fmt.Sprintf("%s-w%d", d.name, d.ids) },
	})
}

// states lists each queued row's state, oldest first.
func (d *device) states() []chaos.RowState {
	var states []chaos.RowState
	for _, row := range d.disk.Rows() {
		states = append(states, row.State)
	}
	return states
}

// inBubble runs a test on virtual time.
func inBubble(t *testing.T, name string, test func(t *testing.T)) {
	t.Helper()
	t.Run(name, func(t *testing.T) { synctest.Test(t, test) })
}

// flush runs one flush to completion and returns its report and the virtual time it took.
func flush(t *testing.T, svc *notesync.Service) (notesync.FlushReport, time.Duration) {
	t.Helper()
	started := time.Now()
	report, err := svc.Flush(context.Background())
	if err != nil {
		t.Fatalf("Flush() error: %v", err)
	}
	return report, time.Since(started)
}

// save queues a note and fails the test if the save is refused.
func save(t *testing.T, svc *notesync.Service, id, text string) {
	t.Helper()
	if _, err := svc.Save(context.Background(), id, text); err != nil {
		t.Fatalf("Save(%q) error: %v", id, err)
	}
}

// noteText is what the server holds for id, or "<none>".
func noteText(server *chaos.FaultServer, id string) string {
	if note, ok := server.Note(id); ok {
		return note.Text
	}
	return "<none>"
}

// expect fails the test unless got equals want.
func expect[T comparable](t *testing.T, what string, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("%s = %v, want %v", what, got, want)
	}
}

func TestFaultInjection(t *testing.T) {
	const hour = time.Hour

	inBubble(t, "drop: retries a dropped request, and a write the server applied before the drop applies once", func(t *testing.T) {
		server := chaos.NewFaultServer(time.Now, chaos.First(
			chaos.ServerFault{Kind: chaos.FaultDropBeforeApply},
			chaos.ServerFault{Kind: chaos.FaultDropAfterApply},
		))
		phone := newDevice(0, chaos.OutboxFaults{})
		svc := phone.start(server)
		save(t, svc, "n", "hello")
		report, _ := flush(t, svc)
		expect(t, "report", report, notesync.FlushReport{Delivered: 1})
		expect(t, "server note", noteText(server, "n"), "hello")
		expect(t, "applies", server.Applies(), 1)
		expect(t, "requests", server.Requests(), 3)
		expect(t, "rows left", len(phone.disk.Rows()), 0)
	})

	inBubble(t, "delay: gives up on a hung request at the timeout, retries, and the late answer applies nothing twice", func(t *testing.T) {
		server := chaos.NewFaultServer(time.Now, chaos.First(chaos.ServerFault{Kind: chaos.FaultDelay, Delay: 10 * time.Minute}))
		phone := newDevice(0, chaos.OutboxFaults{})
		svc := phone.start(server)
		save(t, svc, "n", "hello")
		report, took := flush(t, svc)
		expect(t, "report", report, notesync.FlushReport{Delivered: 1})
		if took >= time.Minute {
			t.Fatalf("flush took %v: it waited out the hung request instead of timing out", took)
		}
		// Let the first request land, 10 minutes after it was sent: the write id makes it a no-op.
		time.Sleep(hour)
		synctest.Wait()
		expect(t, "server note", noteText(server, "n"), "hello")
		expect(t, "applies", server.Applies(), 1)
		expect(t, "rows left", len(phone.disk.Rows()), 0)
	})

	inBubble(t, "5xx: retries with backoff and delivers", func(t *testing.T) {
		server := chaos.NewFaultServer(time.Now, chaos.First(
			chaos.ServerFault{Kind: chaos.FaultServerError, Status: 503},
			chaos.ServerFault{Kind: chaos.FaultServerError, Status: 502},
		))
		svc := newDevice(0, chaos.OutboxFaults{}).start(server)
		save(t, svc, "n", "hello")
		report, took := flush(t, svc)
		expect(t, "report", report, notesync.FlushReport{Delivered: 1})
		expect(t, "server note", noteText(server, "n"), "hello")
		expect(t, "requests", server.Requests(), 3)
		// Two backoffs actually waited: the first step, then double it.
		if want := config.SyncBackoffBase * (1 + 2); took < want {
			t.Fatalf("flush took %v, want at least %v of backoff", took, want)
		}
	})

	inBubble(t, "5xx: past the attempt budget the write stays queued, not lost", func(t *testing.T) {
		// Down for three budgets' worth of requests, then up: a flush that ignored its budget would
		// keep going and deliver, which this test counts as a failure (an endless 503 would hang instead).
		down := chaos.ServerFault{Kind: chaos.FaultServerError, Status: 503}
		server := chaos.NewFaultServer(time.Now, func(request int) (chaos.ServerFault, bool) {
			return down, request < 3*config.SyncMaxAttempts
		})
		phone := newDevice(0, chaos.OutboxFaults{})
		svc := phone.start(server)
		save(t, svc, "n", "hello")
		report, _ := flush(t, svc)
		expect(t, "report", report, notesync.FlushReport{Requeued: 1})
		expect(t, "requests", server.Requests(), config.SyncMaxAttempts)
		expect(t, "rows", fmt.Sprint(phone.states()), fmt.Sprint([]chaos.RowState{chaos.RowPending}))
	})

	inBubble(t, "4xx, 5xx's neighbour: not retried, and parked rather than dropped", func(t *testing.T) {
		server := chaos.NewFaultServer(time.Now, chaos.First(chaos.ServerFault{Kind: chaos.FaultRefused, Status: 400}))
		phone := newDevice(0, chaos.OutboxFaults{})
		svc := phone.start(server)
		save(t, svc, "n", "hello")
		report, _ := flush(t, svc)
		expect(t, "report", report, notesync.FlushReport{Refused: 1})
		expect(t, "requests", server.Requests(), 1)
		expect(t, "rows", fmt.Sprint(phone.states()), fmt.Sprint([]chaos.RowState{chaos.RowParked}))
	})

	for _, kill := range []chaos.KillPoint{chaos.KillAfterClaim, chaos.KillBeforeRemove} {
		inBubble(t, fmt.Sprintf("kill mid-write (%s): the restarted process delivers the write exactly once", kill), func(t *testing.T) {
			server := chaos.NewFaultServer(time.Now, nil)
			phone := newDevice(0, chaos.OutboxFaults{Kill: kill})
			save(t, phone.start(server), "n", "hello")

			_, err := phone.start(server).Flush(context.Background())
			var killed *chaos.ProcessKilledError
			if !errors.As(err, &killed) {
				t.Fatalf("Flush() error = %v, want the process kill", err)
			}

			restarted := phone.start(server)
			if _, err := restarted.Flush(context.Background()); err != nil {
				t.Fatalf("restarted Flush() error: %v", err)
			}
			expect(t, "server note", noteText(server, "n"), "hello")
			expect(t, "applies", server.Applies(), 1)
			expect(t, "rows left", len(phone.disk.Rows()), 0)
		})
	}

	inBubble(t, "clock skew: a device an hour fast doesn't beat a later statement from an honest one", func(t *testing.T) {
		server := chaos.NewFaultServer(time.Now, nil)
		fast := newDevice(hour, chaos.OutboxFaults{}).start(server)
		honest := newDevice(0, chaos.OutboxFaults{}).start(server)
		save(t, fast, "n", "from the fast clock")
		flush(t, fast)
		time.Sleep(time.Minute)
		save(t, honest, "n", "said a minute later")
		flush(t, honest)
		expect(t, "server note", noteText(server, "n"), "said a minute later")
	})

	inBubble(t, "clock skew, the other way: a device an hour slow loses its later edit, and is told delivered", func(t *testing.T) {
		// Documents current behavior, not the goal: compose-time last-writer-wins can't tell a slow
		// clock from an old edit. docs/deferred.md → "Go pack: a slow clock's later edit loses".
		// When that entry is taken, this test flips to expect the later edit.
		server := chaos.NewFaultServer(time.Now, nil)
		honest := newDevice(0, chaos.OutboxFaults{}).start(server)
		slow := newDevice(-hour, chaos.OutboxFaults{}).start(server)
		save(t, honest, "n", "said first")
		flush(t, honest)
		time.Sleep(time.Minute)
		save(t, slow, "n", "said a minute later")
		report, _ := flush(t, slow)
		expect(t, "report", report, notesync.FlushReport{Delivered: 1})
		expect(t, "server note", noteText(server, "n"), "said first")
	})

	inBubble(t, "full disk: the save is refused as storage-full, nothing half-saved or sent; it works once space is back", func(t *testing.T) {
		server := chaos.NewFaultServer(time.Now, nil)
		phone := newDevice(0, chaos.OutboxFaults{Full: true})
		svc := phone.start(server)
		if _, err := svc.Save(context.Background(), "n", "hello"); !errors.Is(err, domain.ErrStorageFull) {
			t.Fatalf("Save() error = %v, want ErrStorageFull", err)
		}
		flush(t, svc)
		expect(t, "rows", len(phone.disk.Rows()), 0)
		expect(t, "requests", server.Requests(), 0)
		expect(t, "server note", noteText(server, "n"), "<none>")

		phone.faults.Full = false
		save(t, svc, "n", "hello")
		flush(t, svc)
		expect(t, "server note", noteText(server, "n"), "hello")
	})
}

// ctxSpy remembers the context of the last Put, so a test can see it was cancelled.
type ctxSpy struct {
	remote notesync.Remote
	last   context.Context
}

func (s *ctxSpy) Put(ctx context.Context, entry notesync.Entry) error {
	s.last = ctx
	return s.remote.Put(ctx, entry)
}

func TestHousekeeping(t *testing.T) {
	inBubble(t, "a quick answer cancels the request timeout, leaving no timer behind", func(t *testing.T) {
		spy := &ctxSpy{remote: chaos.NewFaultServer(time.Now, nil)}
		svc := newDevice(0, chaos.OutboxFaults{}).start(spy)
		save(t, svc, "n", "hello")
		flush(t, svc)
		if spy.last == nil || spy.last.Err() == nil {
			t.Fatal("the request's context is still live after Flush returned: its timeout timer leaks")
		}
	})

	inBubble(t, "overlapping flushes share one run, so nothing is sent twice", func(t *testing.T) {
		server := chaos.NewFaultServer(time.Now, chaos.First(chaos.ServerFault{Kind: chaos.FaultDelay, Delay: time.Second}))
		svc := newDevice(0, chaos.OutboxFaults{}).start(server)
		save(t, svc, "n", "hello")

		var wg sync.WaitGroup
		reports := make([]notesync.FlushReport, 2)
		for i := range reports {
			wg.Add(1)
			go func() {
				defer wg.Done()
				reports[i], _ = svc.Flush(context.Background())
				// The second caller must arrive while the first is still waiting on the delayed request.
			}()
			synctest.Wait()
		}
		wg.Wait()
		expect(t, "requests", server.Requests(), 1)
		expect(t, "applies", server.Applies(), 1)
		expect(t, "both callers got the same report", reports[0], reports[1])
	})

	inBubble(t, "a cancelled caller stops its own flush, and the claimed write is left for the next flush to release", func(t *testing.T) {
		server := chaos.NewFaultServer(time.Now, chaos.First(chaos.ServerFault{Kind: chaos.FaultDelay, Delay: time.Second}))
		phone := newDevice(0, chaos.OutboxFaults{})
		svc := phone.start(server)
		save(t, svc, "n", "hello")

		ctx, cancel := context.WithCancel(context.Background())
		var err error
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, err = svc.Flush(ctx)
		}()
		synctest.Wait() // the first request is in flight
		cancel()
		<-done
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Flush() error = %v, want context.Canceled", err)
		}
		expect(t, "rows", fmt.Sprint(phone.states()), fmt.Sprint([]chaos.RowState{chaos.RowClaimed}))

		// The next flush releases the dead claim and delivers.
		report, _ := flush(t, svc)
		expect(t, "report", report, notesync.FlushReport{Delivered: 1})
		time.Sleep(time.Hour)
		synctest.Wait()
		expect(t, "applies", server.Applies(), 1)
	})

	inBubble(t, "a second caller waiting on a running flush honours its own context", func(t *testing.T) {
		server := chaos.NewFaultServer(time.Now, chaos.First(chaos.ServerFault{Kind: chaos.FaultDelay, Delay: time.Second}))
		svc := newDevice(0, chaos.OutboxFaults{}).start(server)
		save(t, svc, "n", "hello")

		var first notesync.FlushReport
		done := make(chan struct{})
		go func() {
			defer close(done)
			first, _ = svc.Flush(context.Background())
		}()
		synctest.Wait()

		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := svc.Flush(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("second Flush() error = %v, want context.Canceled", err)
		}
		<-done
		expect(t, "first caller's report", first, notesync.FlushReport{Delivered: 1})
	})
}

// anyFault draws a fault the server may play, or none.
func anyFault(t *rapid.T, label string) (chaos.ServerFault, bool) {
	switch rapid.IntRange(0, 4).Draw(t, label+"Kind") {
	case 0:
		return chaos.ServerFault{}, false
	case 1:
		return chaos.ServerFault{Kind: chaos.FaultDropBeforeApply}, true
	case 2:
		return chaos.ServerFault{Kind: chaos.FaultDropAfterApply}, true
	case 3:
		delay := time.Duration(rapid.IntRange(1, 20_000).Draw(t, label+"Ms")) * time.Millisecond
		return chaos.ServerFault{Kind: chaos.FaultDelay, Delay: delay}, true
	default:
		status := rapid.SampledFrom([]int{500, 502, 503}).Draw(t, label+"Status")
		return chaos.ServerFault{Kind: chaos.FaultServerError, Status: status}, true
	}
}

func TestRandomFaultScripts(t *testing.T) {
	// rapid reads the test deadline, which a synctest bubble forbids, so rapid sits outside and each
	// run opens its own bubble. The bubble returns what went wrong instead of failing: rapid's
	// failure is a panic, and a panic in the bubble's goroutine would skip rapid's shrinking.
	rapid.Check(t, func(rt *rapid.T) {
		type scripted struct {
			fault   chaos.ServerFault
			faulted bool
		}
		script := rapid.SliceOfN(rapid.Custom(func(rt *rapid.T) scripted {
			fault, faulted := anyFault(rt, "fault")
			return scripted{fault, faulted}
		}), 0, 12).Draw(rt, "script")
		type saving struct{ id, text string }
		saves := rapid.SliceOfN(rapid.Custom(func(rt *rapid.T) saving {
			return saving{rapid.SampledFrom([]string{"a", "b", "c"}).Draw(rt, "id"), rapid.String().Draw(rt, "text")}
		}), 1, 6).Draw(rt, "saves")

		var problem string
		synctest.Test(t, func(*testing.T) {
			server := chaos.NewFaultServer(time.Now, func(request int) (chaos.ServerFault, bool) {
				if request < len(script) {
					return script[request].fault, script[request].faulted
				}
				return chaos.ServerFault{}, false
			})
			phone := newDevice(0, chaos.OutboxFaults{})
			svc := phone.start(server)
			last := map[string]string{}
			for _, s := range saves {
				if _, err := svc.Save(context.Background(), s.id, s.text); err != nil {
					problem = fmt.Sprintf("Save: %v", err)
					return
				}
				last[s.id] = s.text
				time.Sleep(time.Millisecond)
			}
			// Enough flushes to outlast the script: each one gives every write the full attempt budget.
			for range 5 {
				if len(phone.disk.Rows()) == 0 {
					break
				}
				if _, err := svc.Flush(context.Background()); err != nil {
					problem = fmt.Sprintf("Flush: %v", err)
					return
				}
			}
			// Let any delayed request land before counting.
			time.Sleep(time.Hour)
			synctest.Wait()

			switch {
			case len(phone.disk.Rows()) != 0:
				problem = fmt.Sprintf("%d writes still queued", len(phone.disk.Rows()))
			case server.Applies() != len(saves):
				problem = fmt.Sprintf("applies = %d, want %d: a write was lost or applied twice", server.Applies(), len(saves))
			default:
				for id, text := range last {
					if got := noteText(server, id); got != text {
						problem = fmt.Sprintf("note %q = %q, want its last statement %q", id, got, text)
					}
				}
			}
		})
		if problem != "" {
			rt.Fatal(problem)
		}
	})
}
