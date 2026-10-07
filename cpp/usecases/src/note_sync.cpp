// The note-sync use-case: queue on save, deliver on flush, with one handler per fault the far side can throw at it.
// In the app: the write path for notes, behind its ports; no I/O of its own.
// Used by: whoever composes it (a UI, an API, a sync timer); note_sync_chaos_test.cpp.
// Uses: ports.hpp, config/sync.hpp.
//
// Each fault has one handler here, and a fault-injection test that fails without it: full disk →
// save returns StorageError::full; drop (Unreachable) → retried; delay → abandoned at the request
// timeout and retried; 5xx → retried with backoff, then left queued; 4xx → parked; kill mid-write →
// the next flush releases dead claims; overlapping flushes → one run. A fast clock is clamped on the
// far side (domain accept_write); a slow clock's later edit still loses (docs/deferred.md).

#include "usecases/notesync/note_sync.hpp"

#include <exception>
#include <type_traits>
#include <utility>
#include <variant>

#include "config/sync.hpp"

namespace notes::usecases {
namespace {

// One send's outcome, after timeouts and transport failures are folded in.
enum class Attempt { applied, refused, transient };

// One request, bounded by the timeout; no answer in time, unreachable, and a 5xx all count as transient.
Attempt attempt(NoteRemote& remote, const OutboxEntry& entry) {
  const RemoteAnswer reply = remote.put(entry, config::sync_request_timeout);
  return std::visit(
      [](const auto& said) {
        using Said = std::decay_t<decltype(said)>;
        if constexpr (std::is_same_v<Said, answer::Applied>) {
          return Attempt::applied;
        } else if constexpr (std::is_same_v<Said, answer::Refused>) {
          // A refusal (4xx) will never pass, so it isn't retried.
          return Attempt::refused;
        } else {
          // Unreachable, TimedOut, or a 5xx: may pass next time. The write id makes the retry a
          // no-op if the first request did reach the server.
          static_assert(std::is_same_v<Said, answer::Unreachable> || std::is_same_v<Said, answer::TimedOut> ||
                        std::is_same_v<Said, answer::ServerError>);
          return Attempt::transient;
        }
      },
      reply);
}

// Tries one write up to the attempt budget, backing off (doubling) between tries.
Attempt deliver(NoteRemote& remote, Sleeper& sleeper, const OutboxEntry& entry) {
  for (int tried = 1;; ++tried) {
    const Attempt result = attempt(remote, entry);
    if (result != Attempt::transient || tried >= config::sync_max_attempts) {
      return result;
    }
    sleeper.sleep_for(config::sync_backoff_base * (1 << (tried - 1)));
  }
}

}  // namespace

NoteSync::NoteSync(NoteOutbox& outbox, NoteRemote& remote, const WallClock& clock, Sleeper& sleeper,
                   std::function<std::string()> new_write_id)
    : outbox_(outbox), remote_(remote), clock_(clock), sleeper_(sleeper), new_write_id_(std::move(new_write_id)) {}

domain::Outcome<domain::Note, StorageError> NoteSync::save(const std::string& id, const std::string& text) {
  domain::Note note{.id = id, .text = text, .composed_at_ms = clock_.now_ms()};
  return outbox_.append(OutboxEntry{.write_id = new_write_id_(), .note = note}).map([&note](domain::Done) {
    return note;
  });
}

FlushReport NoteSync::flush() {
  std::promise<FlushReport> mine;
  std::shared_future<FlushReport> shared;
  {
    const std::scoped_lock lock(flight_mutex_);
    // Someone is already flushing: two at once would both send the same writes, and the second's
    // release_claims would un-claim the first's in-flight row. Wait for theirs instead.
    if (in_flight_.has_value()) {
      shared = *in_flight_;
    } else {
      in_flight_ = mine.get_future().share();
    }
  }
  if (shared.valid()) {
    return shared.get();
  }
  try {
    mine.set_value(flush_once());
  } catch (...) {
    // Any failure (a killed process, a bug) is handed to the callers sharing this run, then
    // rethrown to this one by get() below; nothing is swallowed.
    mine.set_exception(std::current_exception());
  }
  std::shared_future<FlushReport> done;
  {
    const std::scoped_lock lock(flight_mutex_);
    done = *in_flight_;
    in_flight_.reset();
  }
  return done.get();
}

FlushReport NoteSync::flush_once() {
  // Dead claims back to pending first: a process killed mid-flush left them.
  outbox_.release_claims();
  FlushReport report;
  for (const OutboxEntry& entry : outbox_.pending()) {
    outbox_.claim(entry.write_id);
    switch (deliver(remote_, sleeper_, entry)) {
      case Attempt::applied:
        outbox_.remove(entry.write_id);
        ++report.delivered;
        break;
      case Attempt::refused:
        outbox_.park(entry.write_id);
        ++report.refused;
        break;
      case Attempt::transient:
        outbox_.release(entry.write_id);
        ++report.requeued;
        break;
    }
  }
  return report;
}

}  // namespace notes::usecases
