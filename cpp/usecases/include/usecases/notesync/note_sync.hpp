// Saves notes to a local outbox and delivers them to the remote, surviving drops, delays, 5xx, crashes, and a full disk.
// In the app: the write path for notes; a UI or API calls save(), a timer or reconnect calls flush().
// Used by: its tests (the seed has no composition root yet).
// Uses: ports.hpp (outbox, remote, wall clock, sleeper), config/sync.hpp (retry knobs).
//
// Each fault has one handler in note_sync.cpp, and a fault-injection test that fails without it
// (cpp/tests/usecases/note_sync_chaos_test.cpp).

#pragma once

#include <functional>
#include <future>
#include <mutex>
#include <optional>
#include <string>

#include "domain/note.hpp"
#include "domain/outcome.hpp"
#include "usecases/notesync/ports.hpp"

namespace notes::usecases {

// What one flush did with each write it tried.
struct FlushReport {
  int delivered = 0;
  int refused = 0;
  int requeued = 0;

  friend bool operator==(const FlushReport&, const FlushReport&) = default;
};

class NoteSync {
 public:
  // The ports are borrowed: the composition root owns them and outlives this.
  NoteSync(NoteOutbox& outbox, NoteRemote& remote, const WallClock& clock, Sleeper& sleeper,
           std::function<std::string()> new_write_id);

  // Stamps and queues a note. Nothing is sent here, so a save works offline.
  domain::Outcome<domain::Note, StorageError> save(const std::string& id, const std::string& text);

  // Sends every queued write once through the retry budget; what is still failing stays queued.
  // Single-flight: a call while one runs gets the running one's report (or its exception).
  FlushReport flush();

 private:
  FlushReport flush_once();

  NoteOutbox& outbox_;
  NoteRemote& remote_;
  const WallClock& clock_;
  Sleeper& sleeper_;
  std::function<std::string()> new_write_id_;

  // The flush running now, if any; overlapping callers share it.
  std::mutex flight_mutex_;
  std::optional<std::shared_future<FlushReport>> in_flight_;
};

}  // namespace notes::usecases
