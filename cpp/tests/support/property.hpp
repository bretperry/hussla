// A seeded property loop for GoogleTest: run a body over many generated inputs, and name the seed that failed.
// In the app: nothing; test support for property tests (note_test.cpp, note_sync_chaos_test.cpp).
// Uses: GoogleTest (SCOPED_TRACE, HasFailure), <random>.
//
// Not a library on purpose (testing-cpp.mdc → Property tests): rapidcheck has no release tags and
// would rebuild in every sanitizer tree. Each run gets its own seed, base + index, so a failure
// message says which seed broke it, and `for_each_seed(1, body, seed)` replays exactly that one.

#pragma once

#include <gtest/gtest.h>

#include <cstdint>
#include <random>
#include <string>

namespace notes::testing {

// Knob: generated cases per property; each is a fresh seed.
inline constexpr int default_runs = 200;

// Knob: the first seed; a fixed base keeps every CI run the same inputs.
inline constexpr std::uint64_t default_base_seed = 0x5EED'0000;

// Calls `body(rng)` once per seed, stopping at the first failing seed (named in the failure).
template <typename Body>
void for_each_seed(int runs, Body body, std::uint64_t base_seed = default_base_seed) {
  for (int index = 0; index < runs; ++index) {
    const std::uint64_t seed = base_seed + static_cast<std::uint64_t>(index);
    SCOPED_TRACE("property seed " + std::to_string(seed) + " (replay: for_each_seed(1, body, " + std::to_string(seed) +
                 "))");
    std::mt19937_64 rng(seed);
    body(rng);
    if (::testing::Test::HasFailure()) {
      return;
    }
  }
}

// A uniform integer in [low, high].
template <typename Int>
Int any_in(std::mt19937_64& rng, Int low, Int high) {
  return std::uniform_int_distribution<Int>(low, high)(rng);
}

// A lowercase string of length [0, max_size].
inline std::string any_text(std::mt19937_64& rng, int max_size) {
  const int size = any_in(rng, 0, max_size);
  std::string text;
  for (int index = 0; index < size; ++index) {
    text.push_back(static_cast<char>('a' + any_in(rng, 0, 25)));
  }
  return text;
}

}  // namespace notes::testing
