// The note merge rule: later compose time wins, a stamp too far ahead is clamped first.
// In the app: the far side's write path; pure, so it runs the same in a server, a store, or a test model.
// Used by: whoever applies writes (the test fault server today).
// Uses: domain/note.hpp.

#include "domain/note.hpp"

namespace notes::domain {

Note merge_note(const std::optional<Note>& stored, const Note& incoming) {
  if (stored.has_value() && stored->composed_at_ms > incoming.composed_at_ms) {
    return *stored;
  }
  return incoming;
}

std::int64_t clamp_composed_at(std::int64_t composed_at_ms, std::int64_t server_now_ms, std::int64_t max_ahead_ms) {
  return composed_at_ms > server_now_ms + max_ahead_ms ? server_now_ms : composed_at_ms;
}

Note accept_write(const std::optional<Note>& stored, const Note& incoming, std::int64_t server_now_ms) {
  Note clamped = incoming;
  clamped.composed_at_ms = clamp_composed_at(incoming.composed_at_ms, server_now_ms);
  return merge_note(stored, clamped);
}

}  // namespace notes::domain
