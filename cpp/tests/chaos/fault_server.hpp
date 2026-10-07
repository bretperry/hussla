// A model of the remote, driven by a fault script: it merges like the real far side and breaks on command.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: note_sync_chaos_test.cpp.
// Uses: domain accept_write (the real merge rule), usecases ports (implements NoteRemote), virtual_clock.hpp.
//
// Not a mock of HTTP: a model of behavior. It stores notes through the same accept_write the real
// far side runs, applies a write id at most once, and reads the clock the server would. So a test
// asserts the outcome (what the server holds, how often a write applied), not a call count.
// Faults are scripted by request index, so "the third request dies after the server applied it"
// is one line, and a failing run replays exactly.

#pragma once

#include <chrono>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <variant>
#include <vector>

#include "chaos/virtual_clock.hpp"
#include "domain/note.hpp"
#include "usecases/notesync/ports.hpp"

namespace notes::chaos {

// Where a request dies. The split that matters is whether the server applied the write first.
namespace fault {
// The connection never reached the server: nothing applied.
struct DropBeforeApply {};
// The server applied the write and the answer was lost on the way back.
struct DropAfterApply {};
// The request takes `duration` in flight, then applies and answers (late, if past the client's timeout).
struct Delay {
  std::chrono::milliseconds duration;
};
// A 5xx before anything is applied.
struct ServerError {
  int status;
};
// A 4xx: the server will never accept this write.
struct Refused {
  int status;
};
}  // namespace fault
using ServerFault =
    std::variant<fault::DropBeforeApply, fault::DropAfterApply, fault::Delay, fault::ServerError, fault::Refused>;

// Faults by zero-based request index; nullopt answers normally.
using FaultScript = std::function<std::optional<ServerFault>(int request)>;

// A script that plays `faults` on the first requests, then answers normally.
FaultScript first_requests(std::vector<ServerFault> faults);

class FaultServer final : public usecases::NoteRemote {
 public:
  // `clock` is the server's own (never skewed); a delayed request's late apply lands on its timers.
  explicit FaultServer(VirtualClock& clock, FaultScript script = {});

  usecases::RemoteAnswer put(const usecases::OutboxEntry& entry, std::chrono::milliseconds timeout) override;

  // Requests received, failed ones included.
  [[nodiscard]] int requests() const;
  // Writes actually applied; a replayed write id doesn't count again.
  [[nodiscard]] int applies() const;
  [[nodiscard]] std::optional<domain::Note> note(const std::string& id) const;

 private:
  // The real far side's write path: a write id applies once; the merge is the domain's.
  void apply(const usecases::OutboxEntry& entry);

  VirtualClock& clock_;
  FaultScript script_;
  mutable std::mutex mutex_;
  int requests_ = 0;
  int applies_ = 0;
  std::map<std::string, domain::Note> notes_;
  std::set<std::string> seen_;
};

}  // namespace notes::chaos
