"""Success-or-failure value for expected outcomes in domain logic and use-cases.
In the app: domain functions and use-cases return a Result for failures a caller must handle (invalid, not found, conflict); a raise means a bug.
Used by: app/domain/**, app/services/note_sync.py, app/ports/note_sync.py, the outbox fake in tests/chaos/, tests.
Uses: nothing; app/domain imports no I/O (ruff TID251 and stacks/python/domain_purity.py) and no other layer (the import-linter `layers` contract).

Why not raise: an exception is invisible in a signature, so a caller that forgets it type-checks
and fails at runtime. A Result makes the failure part of the type. Give `E` a frozen dataclass per
failure kind and `match` on it: pyright strict reports a `match` that misses a kind
(reportMatchNotExhaustive), so adding a kind fails the types until every caller handles it.
Exceptions stay for broken invariants.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Generic, Literal, TypeVar

T = TypeVar("T")
U = TypeVar("U")
E = TypeVar("E")
F = TypeVar("F")
# Covariant in the dataclasses, so an Err[str] is a Result[int, str | int] (and_then widens E).
T_co = TypeVar("T_co", covariant=True)
E_co = TypeVar("E_co", covariant=True)


@dataclass(frozen=True, slots=True)
class Ok(Generic[T_co]):
    value: T_co
    # A literal, so `if not result.ok` narrows a Result to its Err.
    ok: Literal[True] = field(default=True, init=False)


@dataclass(frozen=True, slots=True)
class Err(Generic[E_co]):
    error: E_co
    ok: Literal[False] = field(default=False, init=False)


Result = Ok[T] | Err[E]


# Transforms a success value; a failure passes through untouched.
def map_ok(result: Result[T, E], transform: Callable[[T], U]) -> Result[U, E]:
    match result:
        case Ok(value):
            return Ok(transform(value))
        case Err():
            return result


# Runs the next step that can itself fail; the first failure short-circuits the chain.
def and_then(result: Result[T, E], step: Callable[[T], Result[U, F]]) -> Result[U, E | F]:
    match result:
        case Ok(value):
            return step(value)
        case Err():
            return result


# Value on success, `fallback` on failure; for callers that genuinely don't care why it failed.
def unwrap_or(result: Result[T, E], fallback: T) -> T:
    match result:
        case Ok(value):
            return value
        case Err():
            return fallback
