//! A clock on tokio's virtual time, optionally skewed: a device whose wall clock is wrong.
//!
//! In the app: nothing at runtime; test support for the tier-2 tests.
//! Used by: `adapters/tests/note_sync_chaos.rs`, `FaultServer` (the server's clock).
//! Uses: `app::ports::Clock`, tokio's paused time (`#[tokio::test(start_paused = true)]`).
//!
//! Under a paused runtime `sleep` costs no real time: tokio advances its clock to the next timer
//! when everything is idle, so a 10-minute delay runs instantly and a failure replays exactly.

use std::future::Future;
use std::time::Duration;

use app::ports::Clock;
use tokio::time::Instant;

/// Wall-clock time that moves only with tokio's clock. `skewed` gives a device whose clock is off.
#[derive(Debug, Clone, Copy)]
pub struct VirtualClock {
    epoch_ms: i64,
    started: Instant,
    skew_ms: i64,
}

impl VirtualClock {
    /// A clock reading `epoch_ms` now, then moving with virtual time.
    #[must_use]
    pub fn new(epoch_ms: i64) -> Self {
        Self {
            epoch_ms,
            started: Instant::now(),
            skew_ms: 0,
        }
    }

    /// The same clock, `skew_ms` fast (negative: slow).
    #[must_use]
    pub const fn skewed(self, skew_ms: i64) -> Self {
        Self { skew_ms, ..self }
    }
}

impl Clock for VirtualClock {
    fn now_ms(&self) -> i64 {
        let elapsed_ms = i64::try_from(self.started.elapsed().as_millis()).unwrap_or(i64::MAX);
        self.epoch_ms.saturating_add(elapsed_ms).saturating_add(self.skew_ms)
    }

    fn sleep(&self, ms: u64) -> impl Future<Output = ()> + Send {
        tokio::time::sleep(Duration::from_millis(ms))
    }
}
