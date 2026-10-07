// A virtual clock for the fault tests: wall time and sleeps that move only when told, plus timers the far side schedules.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: note_sync_chaos_test.cpp, fault_server.cpp (a late write lands on a timer).
// Uses: usecases ports (WallClock, Sleeper).
//
// A sleep advances time and runs every timer that falls due on the way, in order, so a backoff
// costs nothing and a hung request's late arrival happens at exactly the virtual moment it would.
// Thread-safe, so the overlapping-flush test can run under ThreadSanitizer; a timer runs with the
// lock released, because it may read the clock.

#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>

#include "usecases/notesync/ports.hpp"

namespace notes::chaos {

class VirtualClock final : public usecases::WallClock, public usecases::Sleeper {
 public:
  explicit VirtualClock(std::int64_t epoch_ms) : epoch_ms_(epoch_ms) {}

  [[nodiscard]] std::int64_t now_ms() const override {
    const std::scoped_lock lock(mutex_);
    return epoch_ms_ + elapsed_ms_;
  }

  // Virtual milliseconds since the clock was made.
  [[nodiscard]] std::int64_t elapsed_ms() const {
    const std::scoped_lock lock(mutex_);
    return elapsed_ms_;
  }

  void sleep_for(std::chrono::milliseconds duration) override { advance(duration); }

  // Runs `task` once virtual time reaches `delay` from now.
  void after(std::chrono::milliseconds delay, std::function<void()> task) {
    const std::scoped_lock lock(mutex_);
    timers_.emplace(elapsed_ms_ + delay.count(), std::move(task));
  }

  // Moves time forward by `duration`, running each timer that falls due on the way.
  void advance(std::chrono::milliseconds duration) {
    std::int64_t until = 0;
    {
      const std::scoped_lock lock(mutex_);
      until = elapsed_ms_ + duration.count();
    }
    run_timers_until(until);
    const std::scoped_lock lock(mutex_);
    elapsed_ms_ = until;
  }

  // Runs every pending timer, moving time to the last one; time stays put when none is pending.
  void run_until_idle() {
    for (;;) {
      std::int64_t next = 0;
      {
        const std::scoped_lock lock(mutex_);
        if (timers_.empty()) {
          return;
        }
        next = timers_.begin()->first;
      }
      run_timers_until(next);
    }
  }

  // Timers still waiting; a quick answer must leave none behind.
  [[nodiscard]] std::size_t pending_timers() const {
    const std::scoped_lock lock(mutex_);
    return timers_.size();
  }

 private:
  void run_timers_until(std::int64_t until) {
    for (;;) {
      std::function<void()> task;
      {
        const std::scoped_lock lock(mutex_);
        if (timers_.empty() || timers_.begin()->first > until) {
          return;
        }
        auto due = timers_.begin();
        elapsed_ms_ = std::max(elapsed_ms_, due->first);
        task = std::move(due->second);
        timers_.erase(due);
      }
      task();
    }
  }

  mutable std::mutex mutex_;
  std::int64_t epoch_ms_;
  std::int64_t elapsed_ms_ = 0;
  std::multimap<std::int64_t, std::function<void()>> timers_;
};

// One device's view of a shared virtual clock: the same time, off by `skew`.
class SkewedClock final : public usecases::WallClock {
 public:
  SkewedClock(const VirtualClock& clock, std::chrono::milliseconds skew) : clock_(clock), skew_(skew) {}

  [[nodiscard]] std::int64_t now_ms() const override { return clock_.now_ms() + skew_.count(); }

 private:
  const VirtualClock& clock_;
  std::chrono::milliseconds skew_;
};

}  // namespace notes::chaos
