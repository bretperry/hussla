// The real clock and sleeper: the system's wall clock, and a sleep that blocks the calling thread.
// In the app: wired into NoteSync by the composition root; tests use a virtual clock instead.
// Used by: the composition root (none in the seed yet).
// Uses: usecases ports (WallClock, Sleeper), <chrono>, <thread>.

#pragma once

#include <chrono>
#include <cstdint>

#include "usecases/notesync/ports.hpp"

namespace notes::adapters {

class SystemClock final : public usecases::WallClock, public usecases::Sleeper {
 public:
  [[nodiscard]] std::int64_t now_ms() const override;
  void sleep_for(std::chrono::milliseconds duration) override;
};

}  // namespace notes::adapters
