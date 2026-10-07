// An in-memory outbox with a fault script: a full disk, or the process killed at a chosen step.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: note_sync_chaos_test.cpp.
// Uses: usecases ports (implements NoteOutbox).
//
// The rows live in a Disk the test keeps, so "restart the process" is a new outbox over the same
// disk. Every step is atomic, like a transactional store: a kill lands between steps, never inside
// one, which is what a kill is to a store with a journal. A kill is an exception (ProcessKilled):
// the flush stops where the process would have, and the test expects exactly that type.

#pragma once

#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "usecases/notesync/ports.hpp"

namespace notes::chaos {

enum class RowState { pending, claimed, parked };

struct Row {
  usecases::OutboxEntry entry;
  RowState state = RowState::pending;
};

// Where a kill can land: after a claim commits (nothing sent yet), or after the send and before
// the remove commits (the server has it; the outbox doesn't know).
enum class KillPoint { after_claim, before_remove };

// What survives a process: the rows in append order, and the faults the next call reads (so a
// test can change them mid-run).
struct Disk {
  std::mutex mutex;
  std::vector<Row> rows;
  bool full = false;
  std::optional<KillPoint> kill;

  [[nodiscard]] std::vector<RowState> states();
};

// What the "process" throws when the script kills it.
class ProcessKilled : public std::runtime_error {
 public:
  explicit ProcessKilled(KillPoint point);
};

class MemoryOutbox final : public usecases::NoteOutbox {
 public:
  explicit MemoryOutbox(Disk& disk) : disk_(disk) {}

  domain::Outcome<domain::Done, usecases::StorageError> append(const usecases::OutboxEntry& entry) override;
  [[nodiscard]] std::vector<usecases::OutboxEntry> pending() const override;
  void claim(const std::string& write_id) override;
  void release(const std::string& write_id) override;
  void release_claims() override;
  void remove(const std::string& write_id) override;
  void park(const std::string& write_id) override;

 private:
  // The row for a write id; a missing one is a bug in the use-case, so it throws.
  Row& row(const std::string& write_id);
  // Dies here if the script says so, once; the restarted process runs clean.
  void die_if_scripted(KillPoint point);

  Disk& disk_;
};

}  // namespace notes::chaos
