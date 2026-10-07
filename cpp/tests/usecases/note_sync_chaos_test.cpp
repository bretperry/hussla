// Fault injection (tier 2, testing.mdc) for note-sync: one test per fault kind, plus a property over random fault scripts.
// In the app: nothing at runtime; runs in `pnpm cpp:test` under ASan + UBSan, and again under ThreadSanitizer (label `chaos`).
// Used by: GoogleTest via CTest.
// Uses: usecases NoteSync, cpp/tests/chaos (FaultServer, MemoryOutbox, VirtualClock, FaultKind), support/property.hpp.
//
// Each test drives the real use-case against a model of the far side and asserts the outcome: what
// the server holds, how many times a write applied, what is still queued. Remove a handler from
// note_sync.cpp and its test goes red; that is the bar for a tier-2 test. Time is virtual
// (VirtualClock), so a ten-minute delay costs nothing and a failure replays exactly. A test's name
// starts with the FaultKind it plays (stacks/cpp/sources.mjs checks every kind has one).

#include <gtest/gtest.h>

#include <chrono>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "chaos/fault_server.hpp"
#include "chaos/memory_outbox.hpp"
#include "chaos/virtual_clock.hpp"
#include "config/sync.hpp"
#include "support/property.hpp"
#include "usecases/notesync/note_sync.hpp"

namespace notes::usecases {
namespace {

using chaos::Disk;
using chaos::FaultServer;
using chaos::first_requests;
using chaos::KillPoint;
using chaos::MemoryOutbox;
using chaos::RowState;
using chaos::ServerFault;
using chaos::SkewedClock;
using chaos::VirtualClock;
using std::chrono::milliseconds;
using std::chrono::minutes;

// Wall-clock ms at virtual time 0, so stamps look like real ones.
constexpr std::int64_t epoch_ms = 1'000'000'000'000;

// One device: its own disk and clock skew, talking to `remote`. start() is a process (re)start: a
// new outbox and use-case over the same disk. Write ids are unique across devices, as real ones are.
class Device {
 public:
  Device(VirtualClock& clock, NoteRemote& remote, std::string name, milliseconds skew = milliseconds{0})
      : clock_(clock), remote_(remote), name_(std::move(name)), wall_(clock, skew) {}

  NoteSync& start() {
    outbox_ = std::make_unique<MemoryOutbox>(disk_);
    sync_ = std::make_unique<NoteSync>(*outbox_, remote_, wall_, clock_,
                                       [this] { return name_ + "-w" + std::to_string(++ids_); });
    return *sync_;
  }

  // What survives a restart: the test reads it and scripts its faults.
  Disk& disk() { return disk_; }

 private:
  VirtualClock& clock_;
  NoteRemote& remote_;
  std::string name_;
  SkewedClock wall_;
  int ids_ = 0;
  Disk disk_;
  std::unique_ptr<MemoryOutbox> outbox_;
  std::unique_ptr<NoteSync> sync_;
};

std::size_t rows(Disk& disk) { return disk.states().size(); }

// The text the server holds for a note, or a marker that it holds none (so a missing note fails the comparison, not the test binary).
std::string text_of(const FaultServer& server, const std::string& id) {
  const std::optional<domain::Note> stored = server.note(id);
  return stored.has_value() ? stored->text : "<no note " + id + ">";
}

TEST(NoteSyncChaos, drop_RetriesAndAWriteTheServerAppliedBeforeTheDropAppliesOnce) {
  VirtualClock clock(epoch_ms);
  FaultServer server(clock, first_requests({chaos::fault::DropBeforeApply{}, chaos::fault::DropAfterApply{}}));
  Device phone(clock, server, "phone");
  NoteSync& sync = phone.start();
  ASSERT_TRUE(sync.save("n", "hello").ok());
  EXPECT_EQ(sync.flush(), (FlushReport{.delivered = 1}));
  EXPECT_EQ(text_of(server, "n"), "hello");
  EXPECT_EQ(server.applies(), 1);
  EXPECT_EQ(server.requests(), 3);
  EXPECT_EQ(rows(phone.disk()), 0U);
}

TEST(NoteSyncChaos, delay_GivesUpOnAHungRequestAtTheTimeoutAndTheLateAnswerAppliesNothingTwice) {
  VirtualClock clock(epoch_ms);
  FaultServer server(clock, first_requests({chaos::fault::Delay{.duration = minutes{10}}}));
  Device phone(clock, server, "phone");
  NoteSync& sync = phone.start();
  ASSERT_TRUE(sync.save("n", "hello").ok());
  EXPECT_EQ(sync.flush(), (FlushReport{.delivered = 1}));
  EXPECT_LT(clock.elapsed_ms(), milliseconds{minutes{1}}.count())
      << "the timeout should have cut the hung request short";
  // Let the hung request land on the server, late.
  clock.run_until_idle();
  EXPECT_EQ(text_of(server, "n"), "hello");
  EXPECT_EQ(server.applies(), 1);
  EXPECT_EQ(rows(phone.disk()), 0U);
}

TEST(NoteSyncChaos, server_error_RetriesWithBackoffAndDelivers) {
  VirtualClock clock(epoch_ms);
  FaultServer server(
      clock, first_requests({chaos::fault::ServerError{.status = 503}, chaos::fault::ServerError{.status = 502}}));
  Device phone(clock, server, "phone");
  NoteSync& sync = phone.start();
  ASSERT_TRUE(sync.save("n", "hello").ok());
  EXPECT_EQ(sync.flush(), (FlushReport{.delivered = 1}));
  EXPECT_EQ(text_of(server, "n"), "hello");
  EXPECT_EQ(server.requests(), 3);
  // Two backoffs actually waited: the first step, then double it.
  EXPECT_GE(clock.elapsed_ms(), config::sync_backoff_base.count() * 3);
}

TEST(NoteSyncChaos, server_error_PastTheAttemptBudgetTheWriteStaysQueuedNotLost) {
  VirtualClock clock(epoch_ms);
  FaultServer server(clock, [](int) -> std::optional<ServerFault> { return chaos::fault::ServerError{.status = 503}; });
  Device phone(clock, server, "phone");
  NoteSync& sync = phone.start();
  ASSERT_TRUE(sync.save("n", "hello").ok());
  EXPECT_EQ(sync.flush(), (FlushReport{.requeued = 1}));
  EXPECT_EQ(server.requests(), config::sync_max_attempts);
  EXPECT_EQ(phone.disk().states(), std::vector<RowState>{RowState::pending});
}

TEST(NoteSyncChaos, refused_IsNotRetriedAndIsParkedRatherThanDropped) {
  VirtualClock clock(epoch_ms);
  FaultServer server(clock, first_requests({chaos::fault::Refused{.status = 400}}));
  Device phone(clock, server, "phone");
  NoteSync& sync = phone.start();
  ASSERT_TRUE(sync.save("n", "hello").ok());
  EXPECT_EQ(sync.flush(), (FlushReport{.refused = 1}));
  EXPECT_EQ(server.requests(), 1);
  EXPECT_EQ(phone.disk().states(), std::vector<RowState>{RowState::parked});
}

// The kill lands at `point`; the restarted process must deliver the write exactly once.
void kill_then_restart(KillPoint point) {
  VirtualClock clock(epoch_ms);
  FaultServer server(clock);
  Device phone(clock, server, "phone");
  ASSERT_TRUE(phone.start().save("n", "hello").ok());
  {
    const std::scoped_lock lock(phone.disk().mutex);
    phone.disk().kill = point;
  }
  EXPECT_THROW(phone.start().flush(), chaos::ProcessKilled);
  phone.start().flush();
  EXPECT_EQ(text_of(server, "n"), "hello");
  EXPECT_EQ(server.applies(), 1);
  EXPECT_EQ(rows(phone.disk()), 0U);
}

TEST(NoteSyncChaos, kill_mid_write_AfterTheClaimTheRestartedProcessDeliversOnce) {
  kill_then_restart(KillPoint::after_claim);
}

TEST(NoteSyncChaos, kill_mid_write_BeforeTheRemoveTheRestartedProcessDeliversOnce) {
  kill_then_restart(KillPoint::before_remove);
}

TEST(NoteSyncChaos, clock_skew_fast_ADeviceAnHourFastDoesNotBeatALaterStatementFromAnHonestOne) {
  VirtualClock clock(epoch_ms);
  FaultServer server(clock);
  Device fast(clock, server, "fast", minutes{60});
  Device honest(clock, server, "honest");
  NoteSync& fast_sync = fast.start();
  NoteSync& honest_sync = honest.start();
  ASSERT_TRUE(fast_sync.save("n", "from the fast clock").ok());
  fast_sync.flush();
  clock.advance(minutes{1});
  ASSERT_TRUE(honest_sync.save("n", "said a minute later").ok());
  honest_sync.flush();
  EXPECT_EQ(text_of(server, "n"), "said a minute later");
}

TEST(NoteSyncChaos, clock_skew_slow_ADeviceAnHourSlowLosesItsLaterEditAndIsToldDelivered) {
  // Documents current behavior, not the goal: compose-time last-writer-wins can't tell a slow
  // clock from an old edit. docs/deferred.md → the C++ pack's slow-clock entry. When that entry
  // is taken, this test flips to expect the later edit.
  VirtualClock clock(epoch_ms);
  FaultServer server(clock);
  Device honest(clock, server, "honest");
  Device slow(clock, server, "slow", -minutes{60});
  NoteSync& honest_sync = honest.start();
  NoteSync& slow_sync = slow.start();
  ASSERT_TRUE(honest_sync.save("n", "said first").ok());
  honest_sync.flush();
  clock.advance(minutes{1});
  ASSERT_TRUE(slow_sync.save("n", "said a minute later").ok());
  EXPECT_EQ(slow_sync.flush(), (FlushReport{.delivered = 1}));
  EXPECT_EQ(text_of(server, "n"), "said first");
}

TEST(NoteSyncChaos, disk_full_TheSaveIsRefusedNothingIsSentAndItWorksOnceSpaceIsBack) {
  VirtualClock clock(epoch_ms);
  FaultServer server(clock);
  Device phone(clock, server, "phone");
  phone.disk().full = true;
  NoteSync& sync = phone.start();
  const auto refused = sync.save("n", "hello");
  ASSERT_FALSE(refused.ok());
  EXPECT_EQ(refused.error(), StorageError::full);
  sync.flush();
  EXPECT_EQ(rows(phone.disk()), 0U);
  EXPECT_EQ(server.requests(), 0);
  EXPECT_FALSE(server.note("n").has_value());

  {
    const std::scoped_lock lock(phone.disk().mutex);
    phone.disk().full = false;
  }
  ASSERT_TRUE(sync.save("n", "hello").ok());
  sync.flush();
  EXPECT_EQ(text_of(server, "n"), "hello");
}

// A remote that holds its first request until the test lets it go, so a second flush can start while the first is
// mid-send.
class HeldRemote final : public NoteRemote {
 public:
  explicit HeldRemote(NoteRemote& inner) : inner_(inner) {}

  RemoteAnswer put(const OutboxEntry& entry, milliseconds timeout) override {
    {
      std::unique_lock lock(mutex_);
      if (!held_once_) {
        held_once_ = true;
        arrived_ = true;
        changed_.notify_all();
        changed_.wait(lock, [this] { return released_; });
      }
    }
    return inner_.put(entry, timeout);
  }

  void wait_for_arrival() {
    std::unique_lock lock(mutex_);
    changed_.wait(lock, [this] { return arrived_; });
  }

  void release() {
    const std::scoped_lock lock(mutex_);
    released_ = true;
    changed_.notify_all();
  }

 private:
  NoteRemote& inner_;
  std::mutex mutex_;
  std::condition_variable changed_;
  bool held_once_ = false;
  bool arrived_ = false;
  bool released_ = false;
};

TEST(NoteSyncChaos, overlapping_flush_SharesOneRunSoNothingIsSentTwice) {
  VirtualClock clock(epoch_ms);
  FaultServer server(clock);
  HeldRemote held(server);
  Device phone(clock, held, "phone");
  NoteSync& sync = phone.start();
  ASSERT_TRUE(sync.save("n", "hello").ok());

  FlushReport first;
  FlushReport second;
  std::thread first_flush([&] { first = sync.flush(); });
  held.wait_for_arrival();
  std::thread second_flush([&] { second = sync.flush(); });
  // Give the second flush time to join the first. Without single-flight it would start its own
  // pass, un-claim the held write, and send it again; with it, it waits. A loaded machine that
  // starts it late can only make this pass, never fail it.
  std::this_thread::sleep_for(milliseconds{100});
  held.release();
  first_flush.join();
  second_flush.join();

  EXPECT_EQ(first, second);
  EXPECT_EQ(server.requests(), 1);
  EXPECT_EQ(server.applies(), 1);
}

TEST(NoteSyncChaos, RandomFaultScriptEverySaveLandsOnceAndEachNoteEndsAsItsLastStatement) {
  using notes::testing::any_in;
  using notes::testing::any_text;
  notes::testing::for_each_seed(60, [](std::mt19937_64& rng) {
    std::vector<std::optional<ServerFault>> faults(any_in<std::size_t>(rng, 0, 12));
    for (auto& fault : faults) {
      switch (any_in(rng, 0, 4)) {
        case 0:
          break;
        case 1:
          fault = chaos::fault::DropBeforeApply{};
          break;
        case 2:
          fault = chaos::fault::DropAfterApply{};
          break;
        case 3:
          fault = chaos::fault::Delay{.duration = milliseconds{any_in<std::int64_t>(rng, 1, 20'000)}};
          break;
        default:
          fault = chaos::fault::ServerError{.status = 500 + any_in(rng, 0, 3)};
          break;
      }
    }
    std::vector<std::pair<std::string, std::string>> saves(any_in<std::size_t>(rng, 1, 6));
    for (auto& [id, text] : saves) {
      id = std::string(1, static_cast<char>('a' + any_in(rng, 0, 2)));
      text = any_text(rng, 8);
    }

    VirtualClock clock(epoch_ms);
    FaultServer server(clock, [&faults](int request) -> std::optional<ServerFault> {
      const auto index = static_cast<std::size_t>(request);
      return index < faults.size() ? faults[index] : std::nullopt;
    });
    Device phone(clock, server, "phone");
    NoteSync& sync = phone.start();
    for (const auto& [id, text] : saves) {
      ASSERT_TRUE(sync.save(id, text).ok());
      clock.advance(milliseconds{1});
    }
    // Enough flushes to outlast the script: each one gives every write the full attempt budget.
    for (int pass = 0; pass < 5 && rows(phone.disk()) > 0; ++pass) {
      sync.flush();
    }
    clock.run_until_idle();

    EXPECT_EQ(rows(phone.disk()), 0U);
    EXPECT_EQ(server.applies(), static_cast<int>(saves.size()));
    std::map<std::string, std::string> last;
    for (const auto& [id, text] : saves) {
      last.insert_or_assign(id, text);
    }
    for (const auto& [id, text] : last) {
      EXPECT_EQ(text_of(server, id), text) << "note " << id;
    }
  });
}

}  // namespace
}  // namespace notes::usecases
