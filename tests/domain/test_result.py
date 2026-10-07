"""Result's laws, as property tests: a failure passes through every combinator untouched.
In the app: nothing at runtime; the worked example of a property test in this pack.
Used by: pytest.
Uses: app/domain/result.py, hypothesis.
"""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from app.domain.result import Err, Ok, Result, and_then, map_ok, unwrap_or


# A failure typed as a Result, so the combinators see both arms.
def fail(reason: str) -> Result[int, str]:
    return Err(reason)


def succeed(value: int) -> Result[int, str]:
    return Ok(value)


class TestResult:
    @given(st.integers())
    def test_map_ok_on_a_success_transforms_the_value(self, value: int) -> None:
        assert map_ok(succeed(value), lambda n: n + 1) == Ok(value + 1)

    @given(st.text())
    def test_a_failure_passes_through_map_ok_and_and_then_untouched(self, reason: str) -> None:
        failure = fail(reason)
        assert map_ok(failure, lambda n: n + 1) == failure
        assert and_then(failure, lambda n: Ok(n + 1)) == failure

    @given(st.integers(), st.integers())
    def test_unwrap_or_returns_the_value_or_the_fallback(self, value: int, fallback: int) -> None:
        success = succeed(value)
        failure = fail("no")
        assert (unwrap_or(success, fallback), unwrap_or(failure, fallback)) == (value, fallback)
