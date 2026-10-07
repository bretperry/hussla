/*
  Success-or-failure value for expected outcomes in domain logic and use-cases.
  In the app: domain functions and use-cases return a Result for failures a caller must handle (invalid, not found, conflict); a throw means a bug.
  Used by: src/domain/**, src/server/services/** (the seed has no callers yet).
  Uses: nothing; src/domain imports no packages (.dependency-cruiser.cjs → domain-imports-no-packages).

  Why not throw: an exception is invisible in a signature, so a caller that forgets it compiles
  and fails at runtime. A Result makes the failure part of the type. Give `E` a `kind` union and
  handle it with a `switch`: oxlint's switch-exhaustiveness-check then fails the lint when a new
  kind is added and some caller has not handled it. Exceptions stay for broken invariants.
*/

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

// Success branch of a Result.
export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

// Failure branch; `error` is usually `{ kind: "…" }` so callers can switch on it exhaustively.
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// Transforms a success value; a failure passes through untouched.
export const map = <T, U, E>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> =>
  result.ok ? ok(transform(result.value)) : result;

// Runs the next step that can itself fail; the first failure short-circuits the chain.
export const andThen = <T, U, E, F>(
  result: Result<T, E>,
  next: (value: T) => Result<U, F>,
): Result<U, E | F> => (result.ok ? next(result.value) : result);

// Value on success, `fallback` on failure; for callers that genuinely don't care why it failed.
export const unwrapOr = <T, E>(result: Result<T, E>, fallback: T): T =>
  result.ok ? result.value : fallback;
