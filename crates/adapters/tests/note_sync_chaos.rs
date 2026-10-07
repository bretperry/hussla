//! Fault injection (tier 2, testing.mdc) for note-sync: one test per fault kind, plus a property over random fault scripts.
//!
//! In the app: nothing at runtime; runs in `pnpm rust:test` on every PR.
//! Used by: cargo nextest.
//! Uses: `adapters::chaos` (fault-script server, in-memory outbox, virtual clock), proptest, tokio's paused time.
//!
//! Each test drives the real use-case against a model of the far side and asserts the outcome:
//! what the server holds, how many times a write applied, what is still queued. Remove a handler
//! from `app/src/note_sync.rs` and its test goes red; that is the bar for a tier-2 test. Time is
//! virtual (`start_paused`), so a 10-minute delay costs nothing and a failure replays exactly:
//! proptest saves a failing case under `proptest-regressions/` and replays it first next run.

#![expect(
    clippy::unwrap_used,
    reason = "a test file is all test: clippy's allow-unwrap-in-tests covers #[test] fns and #[cfg(test)] modules, not this file's helpers"
)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adapters::chaos::{
    Disk, DropWhen, FaultScript, FaultServer, KillPoint, MemoryOutbox, OutboxFaults, RowState, ServerFault,
    VirtualClock,
};
use app::config::{SYNC_BACKOFF_BASE_MS, SYNC_MAX_ATTEMPTS};
use app::note_sync::{FlushReport, NoteSync};
use app::ports::StorageError;
use proptest::prelude::*;
use tokio::time::{Instant, sleep};

const START_MS: i64 = 1_000_000_000;
const HOUR_MS: i64 = 3_600_000;

// Write ids are unique across devices, as real ones (UUIDs) are; the server dedupes on them.
static DEVICES: AtomicUsize = AtomicUsize::new(0);

// One device: its own disk and outbox faults, talking to `server`. `start` is a process (re)start.
struct Device {
    disk: Disk,
    faults: Arc<Mutex<OutboxFaults>>,
    server: FaultServer,
    clock: VirtualClock,
    name: usize,
    ids: Arc<AtomicUsize>,
}

impl Device {
    fn new(world: VirtualClock, server: &FaultServer, skew_ms: i64) -> Self {
        Self {
            disk: Disk::default(),
            faults: Arc::default(),
            server: server.clone(),
            clock: world.skewed(skew_ms),
            name: DEVICES.fetch_add(1, Ordering::SeqCst),
            ids: Arc::default(),
        }
    }

    fn with_faults(self, faults: OutboxFaults) -> Self {
        *self.faults.lock().unwrap() = faults;
        self
    }

    fn set_full(&self, full: bool) {
        self.faults.lock().unwrap().full = full;
    }

    fn start(&self) -> NoteSync<MemoryOutbox, FaultServer, VirtualClock, impl Fn() -> String + use<>> {
        let (name, ids) = (self.name, Arc::clone(&self.ids));
        NoteSync::new(
            MemoryOutbox::new(self.disk.clone(), Arc::clone(&self.faults)),
            self.server.clone(),
            self.clock,
            move || format!("d{name}-w{}", ids.fetch_add(1, Ordering::SeqCst)),
        )
    }
}

fn world() -> VirtualClock {
    VirtualClock::new(START_MS)
}

fn script(faults: Vec<Option<ServerFault>>) -> FaultScript {
    Box::new(move |request| faults.get(request).copied().flatten())
}

// A script that plays `faults` on the first requests, then answers normally.
fn first<const N: usize>(faults: [ServerFault; N]) -> FaultScript {
    script(faults.into_iter().map(Some).collect())
}

// Runs `work` to completion; returns its output and the virtual time it took.
async fn timed<T>(work: impl std::future::Future<Output = T>) -> (T, Duration) {
    let started = Instant::now();
    let output = work.await;
    (output, started.elapsed())
}

#[tokio::test(start_paused = true)]
async fn drop_is_retried_and_a_write_applied_before_the_drop_applies_once() {
    let world = world();
    let server = FaultServer::new(
        world,
        first([
            ServerFault::Drop {
                when: DropWhen::BeforeApply,
            },
            ServerFault::Drop {
                when: DropWhen::AfterApply,
            },
        ]),
    );
    let phone = Device::new(world, &server, 0);
    let sync = phone.start();
    sync.save("n", "hello").await.unwrap();
    let report = sync.flush().await.unwrap();
    assert_eq!(
        report,
        FlushReport {
            delivered: 1,
            refused: 0,
            requeued: 0
        }
    );
    assert_eq!(server.note("n").map(|n| n.text), Some("hello".into()));
    assert_eq!((server.applies(), server.requests(), phone.disk.len()), (1, 3, 0));
}

#[tokio::test(start_paused = true)]
async fn delay_gives_up_on_a_hung_request_at_the_timeout_and_retries() {
    let world = world();
    let server = FaultServer::new(world, first([ServerFault::Delay { ms: 10 * 60_000 }]));
    let phone = Device::new(world, &server, 0);
    let sync = phone.start();
    sync.save("n", "hello").await.unwrap();
    let (report, took) = timed(sync.flush()).await;
    assert_eq!(report.unwrap().delivered, 1);
    assert!(took < Duration::from_mins(1), "waited out the hung request: {took:?}");
    assert_eq!(
        (server.note("n").map(|n| n.text), server.applies(), phone.disk.len()),
        (Some("hello".into()), 1, 0)
    );
    // The hung request still reaches the server long after the client gave up; the write id makes it a replay, not a second apply.
    sleep(Duration::from_mins(11)).await;
    assert_eq!((server.requests(), server.applies(), server.replays()), (2, 1, 1));
}

#[tokio::test(start_paused = true)]
async fn server_error_is_retried_with_backoff_then_the_write_stays_queued_not_lost() {
    let world = world();
    let flaky = FaultServer::new(
        world,
        first([
            ServerFault::ServerError { status: 503 },
            ServerFault::ServerError { status: 502 },
        ]),
    );
    let sync = Device::new(world, &flaky, 0).start();
    sync.save("n", "hello").await.unwrap();
    let (report, took) = timed(sync.flush()).await;
    assert_eq!(report.unwrap().delivered, 1);
    assert_eq!(
        (flaky.note("n").map(|n| n.text), flaky.requests()),
        (Some("hello".into()), 3)
    );
    // Two backoffs actually waited: the first step, then double it.
    assert!(
        took >= Duration::from_millis(SYNC_BACKOFF_BASE_MS * (1 + 2)),
        "backoff skipped: {took:?}"
    );

    let down = FaultServer::new(world, Box::new(|_| Some(ServerFault::ServerError { status: 503 })));
    let phone = Device::new(world, &down, 0);
    let stuck = phone.start();
    stuck.save("n", "hello").await.unwrap();
    let report = stuck.flush().await.unwrap();
    assert_eq!((report.delivered, report.requeued), (0, 1));
    assert_eq!(down.requests(), usize::try_from(SYNC_MAX_ATTEMPTS).unwrap());
    assert_eq!(phone.disk.states(), [RowState::Pending]);
}

#[tokio::test(start_paused = true)]
async fn refused_is_not_retried_and_parked_rather_than_dropped() {
    let world = world();
    let server = FaultServer::new(world, first([ServerFault::Refused { status: 400 }]));
    let phone = Device::new(world, &server, 0);
    let sync = phone.start();
    sync.save("n", "hello").await.unwrap();
    assert_eq!(sync.flush().await.unwrap().refused, 1);
    assert_eq!((server.requests(), phone.disk.states()), (1, vec![RowState::Parked]));
}

async fn killed_mid_write_is_delivered_exactly_once(kill: KillPoint) {
    let world = world();
    let server = FaultServer::healthy(world);
    let phone = Device::new(world, &server, 0).with_faults(OutboxFaults {
        full: false,
        kill: Some(kill),
    });
    phone.start().save("n", "hello").await.unwrap();
    assert_eq!(phone.start().flush().await, Err(StorageError::Unavailable));

    let restarted = phone.start();
    restarted.flush().await.unwrap();
    assert_eq!(
        (server.note("n").map(|n| n.text), server.applies(), phone.disk.len()),
        (Some("hello".into()), 1, 0)
    );
}

#[tokio::test(start_paused = true)]
async fn kill_after_claim_the_restarted_process_delivers_the_write() {
    killed_mid_write_is_delivered_exactly_once(KillPoint::AfterClaim).await;
}

#[tokio::test(start_paused = true)]
async fn kill_before_remove_the_restarted_process_resends_and_the_server_applies_it_once() {
    killed_mid_write_is_delivered_exactly_once(KillPoint::BeforeRemove).await;
}

#[tokio::test(start_paused = true)]
async fn clock_skew_a_device_an_hour_fast_does_not_beat_a_later_statement_from_an_honest_one() {
    let world = world();
    let server = FaultServer::healthy(world);
    let fast = Device::new(world, &server, HOUR_MS).start();
    let honest = Device::new(world, &server, 0).start();
    fast.save("n", "from the fast clock").await.unwrap();
    fast.flush().await.unwrap();
    sleep(Duration::from_mins(1)).await;
    honest.save("n", "said a minute later").await.unwrap();
    honest.flush().await.unwrap();
    assert_eq!(server.note("n").map(|n| n.text), Some("said a minute later".into()));
}

#[tokio::test(start_paused = true)]
async fn clock_skew_the_other_way_a_device_an_hour_slow_loses_its_later_edit_and_is_told_delivered() {
    // Documents current behavior, not the goal: compose-time last-writer-wins can't tell a slow
    // clock from an old edit (the TypeScript seed pins the same, docs/deferred.md). When that
    // entry is taken, this test flips to expect the later edit.
    let world = world();
    let server = FaultServer::healthy(world);
    let honest = Device::new(world, &server, 0).start();
    let slow = Device::new(world, &server, -HOUR_MS).start();
    honest.save("n", "said first").await.unwrap();
    honest.flush().await.unwrap();
    sleep(Duration::from_mins(1)).await;
    slow.save("n", "said a minute later").await.unwrap();
    assert_eq!(slow.flush().await.unwrap().delivered, 1);
    assert_eq!(server.note("n").map(|n| n.text), Some("said first".into()));
}

#[tokio::test(start_paused = true)]
async fn full_disk_refuses_the_save_sends_nothing_and_works_once_space_is_back() {
    let world = world();
    let server = FaultServer::healthy(world);
    let phone = Device::new(world, &server, 0).with_faults(OutboxFaults { full: true, kill: None });
    let sync = phone.start();
    assert_eq!(sync.save("n", "hello").await, Err(StorageError::Full));
    sync.flush().await.unwrap();
    assert_eq!((phone.disk.len(), server.requests(), server.note("n")), (0, 0, None));

    phone.set_full(false);
    sync.save("n", "hello").await.unwrap();
    sync.flush().await.unwrap();
    assert_eq!(server.note("n").map(|n| n.text), Some("hello".into()));
}

#[tokio::test(start_paused = true)]
async fn overlapping_flushes_run_one_at_a_time_so_nothing_is_sent_twice() {
    let world = world();
    let server = FaultServer::new(world, first([ServerFault::Delay { ms: 1_000 }]));
    let sync = Device::new(world, &server, 0).start();
    sync.save("n", "hello").await.unwrap();
    let (a, b) = tokio::join!(sync.flush(), sync.flush());
    assert_eq!((a.unwrap().delivered, b.unwrap().delivered), (1, 0));
    assert_eq!((server.requests(), server.applies()), (1, 1));
}

fn any_fault() -> impl Strategy<Value = Option<ServerFault>> {
    prop_oneof![
        Just(None),
        Just(Some(ServerFault::Drop {
            when: DropWhen::BeforeApply
        })),
        Just(Some(ServerFault::Drop {
            when: DropWhen::AfterApply
        })),
        (1_u64..20_000).prop_map(|ms| Some(ServerFault::Delay { ms })),
        prop::sample::select(vec![500_u16, 502, 503]).prop_map(|status| Some(ServerFault::ServerError { status })),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]

    // The law: whatever the fault script, every save lands exactly once, and each note ends as its last statement.
    #[test]
    fn every_save_lands_exactly_once_under_a_random_fault_script(
        faults in prop::collection::vec(any_fault(), 0..12),
        saves in prop::collection::vec((prop::sample::select(vec!["a", "b", "c"]), ".{0,8}"), 1..6),
    ) {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().start_paused(true).build().unwrap();
        runtime.block_on(async {
            let world = world();
            let server = FaultServer::new(world, script(faults));
            let phone = Device::new(world, &server, 0);
            let sync = phone.start();
            for (id, text) in &saves {
                sync.save(id, text).await.unwrap();
                sleep(Duration::from_millis(1)).await;
            }
            // Enough flushes to outlast the script: each one gives every write the full attempt budget.
            for _ in 0..5 {
                if phone.disk.is_empty() {
                    break;
                }
                sync.flush().await.unwrap();
            }

            prop_assert!(phone.disk.is_empty());
            prop_assert_eq!(server.applies(), saves.len());
            let last: std::collections::HashMap<_, _> = saves.iter().cloned().collect();
            for (id, text) in last {
                prop_assert_eq!(server.note(id).map(|n| n.text), Some(text));
            }
            Ok(())
        })?;
    }
}
