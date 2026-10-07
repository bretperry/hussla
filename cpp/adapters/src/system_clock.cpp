// The system's wall clock in epoch milliseconds, and a blocking sleep.
// In the app: the only place the seed reads real time; the domain and use-cases get it through ports.
// Used by: the composition root.
// Uses: <chrono>, <thread>.

#include "adapters/system_clock.hpp"

#include <thread>

namespace notes::adapters {

std::int64_t SystemClock::now_ms() const {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}

void SystemClock::sleep_for(std::chrono::milliseconds duration) { std::this_thread::sleep_for(duration); }

}  // namespace notes::adapters
