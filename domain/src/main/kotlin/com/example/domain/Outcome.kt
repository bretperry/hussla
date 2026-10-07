/*
  Success-or-failure value for expected outcomes in domain logic and use-cases.
  In the app: domain functions and use-cases return an Outcome for failures a caller must handle (invalid, not found, full); a throw means a bug.
  Used by: usecases NoteSync and its ports (NoteOutbox.append), their tests.

  Why not throw: Kotlin has no checked exceptions, so a caller that forgets one compiles and fails
  at runtime. An Outcome puts the failure in the signature. Give `E` a sealed type and handle it
  with `when`: the compiler then refuses a `when` that misses a case, so a new failure kind
  can't go unhandled. Why not kotlin.Result: its failure is any Throwable, so the type says
  nothing about which failures to expect. Exceptions stay for broken invariants.
*/
package com.example.domain

sealed interface Outcome<out T, out E> {
    data class Ok<out T>(val value: T) : Outcome<T, Nothing>

    data class Err<out E>(val error: E) : Outcome<Nothing, E>
}

// Transforms a success value; a failure passes through untouched.
inline fun <T, U, E> Outcome<T, E>.map(transform: (T) -> U): Outcome<U, E> =
    when (this) {
        is Outcome.Ok -> Outcome.Ok(transform(value))
        is Outcome.Err -> this
    }

// Runs the next step that can itself fail; the first failure short-circuits the chain.
inline fun <T, U, E> Outcome<T, E>.andThen(next: (T) -> Outcome<U, E>): Outcome<U, E> =
    when (this) {
        is Outcome.Ok -> next(value)
        is Outcome.Err -> this
    }

// Value on success, `fallback` on failure; for callers that genuinely don't care why it failed.
fun <T, E> Outcome<T, E>.getOrElse(fallback: T): T =
    when (this) {
        is Outcome.Ok -> value
        is Outcome.Err -> fallback
    }
