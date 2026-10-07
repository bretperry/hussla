// The fault catalogue: every kind of failure the note-sync seed handles, one fault test each.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: stacks/cpp/sources.mjs (every kind needs a test named after it), note_sync_chaos_test.cpp.
//
// A kind here with no `TEST(…, <kind>_…)` fails `pnpm cpp:lint`, and that test must run (`pnpm
// cpp:test` fails a test in the source that is missing from the run), so adding a fault means
// adding its test.

#pragma once

namespace notes::chaos {

enum class FaultKind {
  drop,
  delay,
  server_error,
  refused,
  kill_mid_write,
  clock_skew_fast,
  clock_skew_slow,
  disk_full,
  overlapping_flush,
};

}  // namespace notes::chaos
