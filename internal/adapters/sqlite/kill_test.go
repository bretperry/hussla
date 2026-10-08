package sqlite_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/adapters/sqlite"
	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/domain"
)

// The kill test re-runs this test binary as the writer child (TestMain below sees the
// environment variable and runs the writer loop instead of the tests), so the parent can send
// it a real SIGKILL while a commit is in flight.
const (
	childDirEnv   = "HUSSLA_KILL_TEST_DIR"
	childRoundEnv = "HUSSLA_KILL_TEST_ROUND"
)

func TestMain(m *testing.M) {
	if dir := os.Getenv(childDirEnv); dir != "" {
		os.Exit(runWriterChild(dir, os.Getenv(childRoundEnv)))
	}
	os.Exit(m.Run())
}

// jobIDFor names the i-th job a round writes.
func jobIDFor(round, i int) string { return fmt.Sprintf("kill-%d-%06d", round, i) }

// runWriterChild writes a job and its activity line in one unit of work, in a loop, and prints
// "ack <i>" only after the commit returned. It never stops on its own; the parent kills it.
func runWriterChild(dir, roundText string) int {
	round, err := strconv.Atoi(roundText)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad round:", err)
		return 2
	}
	ctx := context.Background()
	opened, err := sqlite.Open(ctx, sqlite.Options{Dir: dir, AppVersion: "kill-test"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "child open:", err)
		return 2
	}
	padding := strings.Repeat("synthetic padding text ", 100) // ~2 KB, so a commit spans several pages
	fmt.Println("ready")
	for i := 0; i < 1_000_000; i++ { // bounded: the parent kills long before this
		id := jobIDFor(round, i)
		now := time.Now()
		job := domain.Job{ID: id, CompanySlug: "kill-co", CreatedAt: domain.NormalizeTime(now), UpdatedAt: domain.NormalizeTime(now),
			Company: "Kill Co", Title: "Role " + id, Status: domain.JobStatusReview, Description: padding}
		err := opened.Atomically(ctx, func(tx store.Tx) error {
			if err := tx.Jobs().Create(ctx, job); err != nil {
				return err
			}
			_, err := tx.Events().Append(ctx, domain.Event{JobID: id, At: domain.NormalizeTime(now), Actor: "kill-test", Action: "created"})
			return err
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, "child write:", err)
			return 3
		}
		fmt.Printf("ack %d\n", i)
	}
	return 0
}

func TestKilledMidWriteLosesNothingAcknowledged(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns child processes")
	}
	const (
		rounds       = 6
		roundTimeout = 30 * time.Second // a bound, not a pace: a round normally takes well under a second
	)
	seed := uint64(time.Now().UnixNano())
	t.Logf("kill timing seed: %d", seed)
	random := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	dir := t.TempDir()
	var acknowledged []string

	for round := 0; round < rounds; round++ {
		target := 1 + random.IntN(60)                                // kill after this many acknowledged writes ...
		extra := time.Duration(random.IntN(4000)) * time.Microsecond // ... plus a random slice of the next commit
		acks := runAndKillChild(t, dir, round, target, extra, roundTimeout)
		for _, i := range acks {
			acknowledged = append(acknowledged, jobIDFor(round, i))
		}
		verifyAfterKill(t, dir, acknowledged)
	}
	if len(acknowledged) < rounds {
		t.Fatalf("the child made too little progress to prove anything: %d acknowledged writes in %d rounds", len(acknowledged), rounds)
	}
	t.Logf("%d acknowledged writes survived %d SIGKILLs", len(acknowledged), rounds)
}

// runAndKillChild starts the writer, waits for `target` acknowledgements (or the timeout), waits
// `extra` more so the kill lands at a random point of a commit, SIGKILLs it, and returns which
// writes it acknowledged before dying.
func runAndKillChild(t *testing.T, dir string, round, target int, extra, timeout time.Duration) []int {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^$") //nolint:gosec // re-running this test binary is the point
	command.Env = append(os.Environ(), childDirEnv+"="+dir, childRoundEnv+"="+strconv.Itoa(round))
	command.Stderr = os.Stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	if err := command.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}

	var (
		mutex    sync.Mutex
		acks     []int
		sawEOF   bool
		reached  = make(chan struct{})
		finished = make(chan struct{})
	)
	go func() {
		defer close(finished)
		scanner := bufio.NewScanner(stdout)
		var once sync.Once
		for scanner.Scan() {
			line := scanner.Text()
			if after, found := strings.CutPrefix(line, "ack "); found {
				i, err := strconv.Atoi(after)
				if err != nil {
					continue // a line cut by the kill
				}
				mutex.Lock()
				acks = append(acks, i)
				enough := len(acks) >= target
				mutex.Unlock()
				if enough {
					once.Do(func() { close(reached) })
				}
			}
		}
		mutex.Lock()
		sawEOF = true
		mutex.Unlock()
	}()

	select {
	case <-reached:
		time.Sleep(extra)
	case <-finished:
		// The child ended by itself: it crashed or failed to open. Wait reports why.
	case <-time.After(timeout):
		t.Log("round timed out waiting for acknowledgements; killing with what it has")
	}
	if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("kill: %v", err)
	}
	<-finished
	waitErr := command.Wait()
	mutex.Lock()
	defer mutex.Unlock()
	var exitError *exec.ExitError
	if !errors.As(waitErr, &exitError) {
		t.Fatalf("the child should have died of the kill, got %v", waitErr)
	}
	// A process killed by a signal reports exit code -1 on Unix; any other code means it stopped by itself.
	if runtime.GOOS != "windows" && exitError.ExitCode() != -1 {
		t.Fatalf("the child stopped by itself with code %d after %d acknowledgements, not by the kill (sawEOF=%v)", exitError.ExitCode(), len(acks), sawEOF)
	}
	return append([]int(nil), acks...)
}

// verifyAfterKill reopens the database (which runs the integrity check and replays the WAL) and
// checks every acknowledged write is there with its activity line, and that no write is half there.
func verifyAfterKill(t *testing.T, dir string, acknowledged []string) {
	t.Helper()
	opened, err := sqlite.Open(t.Context(), sqlite.Options{Dir: dir, AppVersion: "kill-test"})
	if err != nil {
		t.Fatalf("reopen after kill (this runs the integrity check): %v", err)
	}
	defer func() {
		if err := opened.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	}()
	if err := opened.View(t.Context(), func(tx store.Tx) error {
		storedJobs, err := tx.Jobs().List(t.Context(), jobs.Filter{})
		if err != nil {
			return err
		}
		storedEvents, err := tx.Events().List(t.Context(), events.Filter{Limit: 10_000_000})
		if err != nil {
			return err
		}
		hasJob := map[string]bool{}
		for _, job := range storedJobs {
			hasJob[job.ID] = true
		}
		eventCount := map[string]int{}
		for _, event := range storedEvents {
			eventCount[event.JobID]++
		}
		for _, id := range acknowledged {
			if !hasJob[id] || eventCount[id] != 1 {
				t.Errorf("acknowledged write %s lost after a SIGKILL (job present: %v, events: %d)", id, hasJob[id], eventCount[id])
			}
		}
		if len(hasJob) != len(eventCount) {
			t.Errorf("a write is half there: %d jobs but %d jobs with an event", len(hasJob), len(eventCount))
		}
		for id := range hasJob {
			if eventCount[id] != 1 {
				t.Errorf("job %s has %d events, want exactly 1", id, eventCount[id])
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("verify: %v", err)
	}
}
