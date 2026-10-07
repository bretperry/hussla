// The memory outbox's steps, each atomic under the disk's lock, with the scripted full disk and kills.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: note_sync_chaos_test.cpp.
// Uses: memory_outbox.hpp.

#include "chaos/memory_outbox.hpp"

#include <algorithm>
#include <ranges>

namespace notes::chaos {

std::vector<RowState> Disk::states() {
  const std::scoped_lock lock(mutex);
  std::vector<RowState> result;
  result.reserve(rows.size());
  for (const Row& stored : rows) {
    result.push_back(stored.state);
  }
  return result;
}

ProcessKilled::ProcessKilled(KillPoint point)
    : std::runtime_error(point == KillPoint::after_claim ? "process killed after claim"
                                                         : "process killed before remove") {}

domain::Outcome<domain::Done, usecases::StorageError> MemoryOutbox::append(const usecases::OutboxEntry& entry) {
  const std::scoped_lock lock(disk_.mutex);
  if (disk_.full) {
    return domain::Failure<usecases::StorageError>{usecases::StorageError::full};
  }
  disk_.rows.push_back(Row{.entry = entry, .state = RowState::pending});
  return domain::Done{};
}

std::vector<usecases::OutboxEntry> MemoryOutbox::pending() const {
  const std::scoped_lock lock(disk_.mutex);
  std::vector<usecases::OutboxEntry> result;
  for (const Row& stored : disk_.rows) {
    if (stored.state == RowState::pending) {
      result.push_back(stored.entry);
    }
  }
  return result;
}

void MemoryOutbox::claim(const std::string& write_id) {
  const std::scoped_lock lock(disk_.mutex);
  row(write_id).state = RowState::claimed;
  die_if_scripted(KillPoint::after_claim);
}

void MemoryOutbox::release(const std::string& write_id) {
  const std::scoped_lock lock(disk_.mutex);
  row(write_id).state = RowState::pending;
}

void MemoryOutbox::release_claims() {
  const std::scoped_lock lock(disk_.mutex);
  for (Row& stored : disk_.rows) {
    if (stored.state == RowState::claimed) {
      stored.state = RowState::pending;
    }
  }
}

void MemoryOutbox::remove(const std::string& write_id) {
  const std::scoped_lock lock(disk_.mutex);
  die_if_scripted(KillPoint::before_remove);
  std::erase_if(disk_.rows, [&write_id](const Row& stored) { return stored.entry.write_id == write_id; });
}

void MemoryOutbox::park(const std::string& write_id) {
  const std::scoped_lock lock(disk_.mutex);
  row(write_id).state = RowState::parked;
}

Row& MemoryOutbox::row(const std::string& write_id) {
  const auto found =
      std::ranges::find_if(disk_.rows, [&write_id](const Row& stored) { return stored.entry.write_id == write_id; });
  if (found == disk_.rows.end()) {
    throw std::logic_error("no outbox row " + write_id);
  }
  return *found;
}

void MemoryOutbox::die_if_scripted(KillPoint point) {
  if (disk_.kill != point) {
    return;
  }
  disk_.kill.reset();
  throw ProcessKilled(point);
}

}  // namespace notes::chaos
