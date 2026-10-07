// The note merge rule's laws, as properties: later wins, merging is idempotent, only a fast stamp is clamped.
// In the app: nothing at runtime; runs in `pnpm cpp:test` (so `pnpm check` and CI), under ASan + UBSan.
// Used by: GoogleTest via CTest.
// Uses: domain/note.hpp, support/property.hpp (seeded generated inputs; a failure names its seed).

#include "domain/note.hpp"

#include <gtest/gtest.h>

#include <cstdint>
#include <random>

#include "config/sync.hpp"
#include "support/property.hpp"

namespace notes::domain {
namespace {

using notes::testing::any_in;
using notes::testing::any_text;
using notes::testing::default_runs;
using notes::testing::for_each_seed;

// Stamps around a fixed server time, so both sides of the clamp are reached.
constexpr std::int64_t server_now = 1'000'000'000'000;
constexpr std::int64_t hour_ms = 3'600'000;

std::int64_t any_stamp(std::mt19937_64& rng) { return any_in(rng, server_now - hour_ms, server_now + hour_ms); }

Note any_note(std::mt19937_64& rng) {
  return Note{.id = any_text(rng, 4), .text = any_text(rng, 8), .composed_at_ms = any_stamp(rng)};
}

TEST(Note, TheLaterStatementWinsAndATieGoesToTheIncomingOne) {
  for_each_seed(default_runs, [](std::mt19937_64& rng) {
    const Note stored = any_note(rng);
    const Note incoming = any_note(rng);
    const Note& expected = stored.composed_at_ms > incoming.composed_at_ms ? stored : incoming;
    EXPECT_EQ(merge_note(stored, incoming), expected);
  });
}

TEST(Note, ApplyingTheSameWriteTwiceChangesNothingTheSecondTime) {
  for_each_seed(default_runs, [](std::mt19937_64& rng) {
    const Note stored = any_note(rng);
    const Note incoming = any_note(rng);
    const Note once = accept_write(stored, incoming, server_now);
    EXPECT_EQ(accept_write(once, incoming, server_now), once);
  });
}

TEST(Note, OnlyAStampPastTheSkewToleranceIsClampedToTheServerClock) {
  for_each_seed(default_runs, [](std::mt19937_64& rng) {
    const std::int64_t stamp = any_stamp(rng);
    const std::int64_t expected = stamp > server_now + config::max_compose_skew_ahead.count() ? server_now : stamp;
    EXPECT_EQ(clamp_composed_at(stamp, server_now), expected);
  });
}

TEST(Note, TheFirstWriteOfANoteIsStoredAsStated) {
  const Note note{.id = "n", .text = "hello", .composed_at_ms = server_now};
  EXPECT_EQ(accept_write(std::nullopt, note, server_now), note);
}

}  // namespace
}  // namespace notes::domain
