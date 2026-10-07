// The ports the note-sync use-case depends on: a local outbox, the remote it delivers to, a wall clock, and a sleeper.
// In the app: contracts only; an adapter per vendor in the adapters layer implements each, wired in the composition root.
// Used by: NoteSync; the fakes in cpp/tests/chaos (fault server, memory outbox, virtual clock); adapters SystemClock.
// Uses: domain types only.
//
// The outbox is durable: a write is in it before anything is sent, so a crash never loses a save.
// A claim marks a write as in flight, and is persisted, which is why a process killed mid-flush
// leaves claims behind that the next flush must release. Time comes in through WallClock and
// Sleeper so tests run on a virtual clock: a ten-minute delay costs nothing and replays exactly.
// An outbox may be called from more than one thread (a save while a flush runs), so an adapter
// for it is thread-safe; the other ports are called by one flush at a time.

#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <variant>
#include <vector>

#include "domain/note.hpp"
#include "domain/outcome.hpp"

namespace notes::usecases {

// One queued write: the note as stated, and the id that makes delivering it twice a no-op.
struct OutboxEntry {
  std::string write_id;
  domain::Note note;

  friend bool operator==(const OutboxEntry&, const OutboxEntry&) = default;
};

// The storage failures a caller handles; anything else is a bug and throws.
enum class StorageError { full };

class NoteOutbox {
 public:
  NoteOutbox() = default;
  NoteOutbox(const NoteOutbox&) = delete;
  NoteOutbox& operator=(const NoteOutbox&) = delete;
  NoteOutbox(NoteOutbox&&) = delete;
  NoteOutbox& operator=(NoteOutbox&&) = delete;
  virtual ~NoteOutbox() = default;

  // Persists a write; full when the disk can't take it (nothing is half-written).
  virtual domain::Outcome<domain::Done, StorageError> append(const OutboxEntry& entry) = 0;
  // Writes waiting to be sent, oldest first; claimed and parked ones are not included.
  [[nodiscard]] virtual std::vector<OutboxEntry> pending() const = 0;
  // Marks a write in flight.
  virtual void claim(const std::string& write_id) = 0;
  // Puts a write back in the queue for a later flush.
  virtual void release(const std::string& write_id) = 0;
  // Puts every claimed write back in the queue: claims left by a process that died mid-flush.
  virtual void release_claims() = 0;
  // Drops a write the remote applied.
  virtual void remove(const std::string& write_id) = 0;
  // Sets aside a write the remote refused for a reason a retry won't fix: out of the queue, but
  // kept for a person to look at, so a refusal never silently loses a save.
  virtual void park(const std::string& write_id) = 0;
};

// What the remote said, or that it said nothing in time. Expected failures are values, so the
// adapter maps a dropped connection to Unreachable; a thrown exception means a bug.
namespace answer {
struct Applied {};
struct Unreachable {};
struct TimedOut {};
struct ServerError {
  int status;
};
struct Refused {
  int status;
};
}  // namespace answer
using RemoteAnswer =
    std::variant<answer::Applied, answer::Unreachable, answer::TimedOut, answer::ServerError, answer::Refused>;

class NoteRemote {
 public:
  NoteRemote() = default;
  NoteRemote(const NoteRemote&) = delete;
  NoteRemote& operator=(const NoteRemote&) = delete;
  NoteRemote(NoteRemote&&) = delete;
  NoteRemote& operator=(NoteRemote&&) = delete;
  virtual ~NoteRemote() = default;

  // Sends one write and waits at most `timeout` for the answer (TimedOut after that). The remote
  // applies a write id at most once, so resending is always safe; a request that timed out may
  // still apply later.
  virtual RemoteAnswer put(const OutboxEntry& entry, std::chrono::milliseconds timeout) = 0;
};

// Wall-clock milliseconds since the epoch; may be wrong (skewed), which the far side's merge rule allows for.
class WallClock {
 public:
  WallClock() = default;
  WallClock(const WallClock&) = delete;
  WallClock& operator=(const WallClock&) = delete;
  WallClock(WallClock&&) = delete;
  WallClock& operator=(WallClock&&) = delete;
  virtual ~WallClock() = default;

  [[nodiscard]] virtual std::int64_t now_ms() const = 0;
};

// Waits between retries; a test's virtual clock moves time forward instead of blocking.
class Sleeper {
 public:
  Sleeper() = default;
  Sleeper(const Sleeper&) = delete;
  Sleeper& operator=(const Sleeper&) = delete;
  Sleeper(Sleeper&&) = delete;
  Sleeper& operator=(Sleeper&&) = delete;
  virtual ~Sleeper() = default;

  virtual void sleep_for(std::chrono::milliseconds duration) = 0;
};

}  // namespace notes::usecases
