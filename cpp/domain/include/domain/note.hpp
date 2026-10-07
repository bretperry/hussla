// A note and the rule that merges two statements of it: the later compose time wins.
// In the app: the far side (a server, a store) applies every incoming write through accept_write.
// Used by: usecases NoteSync (the type), the test fault server (it merges with the real rule), note_test.cpp.
// Uses: config/sync.hpp (max_compose_skew_ahead).
//
// Why compose time and not arrival time: a write queued offline arrives late, and must not
// overwrite something stated after it. Why the clamp: compose time comes from the device's clock,
// so a device an hour fast would otherwise win every comparison for the next hour. Times are whole
// milliseconds since the epoch, passed in: the domain reads no clock.

#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include "config/sync.hpp"

namespace notes::domain {

struct Note {
  std::string id;
  std::string text;
  std::int64_t composed_at_ms = 0;

  friend bool operator==(const Note&, const Note&) = default;
};

// The stored note after `incoming` is applied: the later statement wins, a tie goes to the incoming one.
[[nodiscard]] Note merge_note(const std::optional<Note>& stored, const Note& incoming);

// A stamp too far ahead of the server's clock becomes the server's clock; anything else is kept.
[[nodiscard]] std::int64_t clamp_composed_at(std::int64_t composed_at_ms, std::int64_t server_now_ms,
                                             std::int64_t max_ahead_ms = config::max_compose_skew_ahead.count());

// Applies one incoming write on the far side: clamp its stamp, then merge.
[[nodiscard]] Note accept_write(const std::optional<Note>& stored, const Note& incoming, std::int64_t server_now_ms);

}  // namespace notes::domain
