// Success-or-failure value for expected outcomes in domain logic and use-cases.
// In the app: domain functions and use-cases return an Outcome for failures a caller must handle (invalid, not found, full); a throw means a bug.
// Used by: usecases NoteSync and its ports (NoteOutbox::append), their tests.
//
// Why not throw: nothing in a C++ signature says what it throws, so a caller that forgets a
// failure compiles and fails at runtime. An Outcome puts the failure in the type, and [[nodiscard]]
// makes ignoring one a warning (an error here). Give `E` an enum class and switch on it with every
// case named: -Wswitch (in -Wall) then refuses a switch that misses one. Why not std::expected:
// it is C++23, and clang 18 can't compile libstdc++ 13's <expected>; swap this for it once the
// toolchain floor moves (docs/deferred.md). Exceptions stay for broken invariants.

#pragma once

#include <utility>
#include <variant>

namespace notes::domain {

// The failure half, so `Outcome<T, E> result = Failure{E::x}` reads as what it is.
template <typename E>
struct Failure {
  E error;
};

template <typename T, typename E>
class [[nodiscard]] Outcome {
 public:
  // NOLINTNEXTLINE(google-explicit-constructor): implicit on purpose, so `return value;` builds an Ok.
  Outcome(T value) : state_(std::in_place_index<0>, std::move(value)) {}
  // NOLINTNEXTLINE(google-explicit-constructor): implicit on purpose, so `return Failure{…};` builds an Err.
  Outcome(Failure<E> failure) : state_(std::in_place_index<1>, std::move(failure.error)) {}

  [[nodiscard]] bool ok() const { return state_.index() == 0; }
  // The value; calling it on a failure is a bug (std::bad_variant_access).
  [[nodiscard]] const T& value() const { return std::get<0>(state_); }
  // The failure; calling it on a success is a bug (std::bad_variant_access).
  [[nodiscard]] const E& error() const { return std::get<1>(state_); }

  // Transforms a success value; a failure passes through untouched.
  template <typename Transform>
  [[nodiscard]] auto map(Transform transform) const -> Outcome<decltype(transform(std::declval<const T&>())), E> {
    if (ok()) {
      return transform(value());
    }
    return Failure<E>{error()};
  }

 private:
  std::variant<T, E> state_;
};

// The success type for an operation that returns nothing but can fail.
struct Done {
  friend bool operator==(Done, Done) = default;
};

}  // namespace notes::domain
