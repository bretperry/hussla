// The fault server's request handling: play the scripted fault for this request, or apply and answer.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: note_sync_chaos_test.cpp.
// Uses: fault_server.hpp, domain accept_write.

#include "chaos/fault_server.hpp"

#include <type_traits>
#include <utility>

namespace notes::chaos {

FaultScript first_requests(std::vector<ServerFault> faults) {
  return [faults = std::move(faults)](int request) -> std::optional<ServerFault> {
    const auto index = static_cast<std::size_t>(request);
    if (index < faults.size()) {
      return faults[index];
    }
    return std::nullopt;
  };
}

FaultServer::FaultServer(VirtualClock& clock, FaultScript script) : clock_(clock), script_(std::move(script)) {}

usecases::RemoteAnswer FaultServer::put(const usecases::OutboxEntry& entry, std::chrono::milliseconds timeout) {
  int request = 0;
  {
    const std::scoped_lock lock(mutex_);
    request = requests_++;
  }
  const std::optional<ServerFault> scripted = script_ ? script_(request) : std::nullopt;
  if (!scripted.has_value()) {
    apply(entry);
    return usecases::answer::Applied{};
  }
  return std::visit(
      [&](const auto& played) -> usecases::RemoteAnswer {
        using Played = std::decay_t<decltype(played)>;
        if constexpr (std::is_same_v<Played, fault::DropBeforeApply>) {
          // What the client's adapter reports when the connection drops: no answer.
          return usecases::answer::Unreachable{};
        } else if constexpr (std::is_same_v<Played, fault::DropAfterApply>) {
          apply(entry);
          return usecases::answer::Unreachable{};
        } else if constexpr (std::is_same_v<Played, fault::Delay>) {
          // In time: the client waits it out. Too slow: the client stops waiting at its timeout,
          // and the server still applies the write when the request finally lands.
          if (played.duration <= timeout) {
            clock_.advance(played.duration);
            apply(entry);
            return usecases::answer::Applied{};
          }
          clock_.after(played.duration, [this, entry] { apply(entry); });
          clock_.advance(timeout);
          return usecases::answer::TimedOut{};
        } else if constexpr (std::is_same_v<Played, fault::ServerError>) {
          return usecases::answer::ServerError{.status = played.status};
        } else {
          static_assert(std::is_same_v<Played, fault::Refused>);
          return usecases::answer::Refused{.status = played.status};
        }
      },
      *scripted);
}

void FaultServer::apply(const usecases::OutboxEntry& entry) {
  const std::int64_t now = clock_.now_ms();
  const std::scoped_lock lock(mutex_);
  if (!seen_.insert(entry.write_id).second) {
    return;
  }
  ++applies_;
  const auto stored = notes_.find(entry.note.id);
  const std::optional<domain::Note> before =
      stored == notes_.end() ? std::nullopt : std::optional<domain::Note>(stored->second);
  notes_.insert_or_assign(entry.note.id, domain::accept_write(before, entry.note, now));
}

int FaultServer::requests() const {
  const std::scoped_lock lock(mutex_);
  return requests_;
}

int FaultServer::applies() const {
  const std::scoped_lock lock(mutex_);
  return applies_;
}

std::optional<domain::Note> FaultServer::note(const std::string& id) const {
  const std::scoped_lock lock(mutex_);
  const auto found = notes_.find(id);
  return found == notes_.end() ? std::nullopt : std::optional<domain::Note>(found->second);
}

}  // namespace notes::chaos
