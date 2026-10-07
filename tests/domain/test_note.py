"""The note merge rule's laws, as property tests: later wins, ties go to the incoming write, a fast clock is clamped.
In the app: nothing at runtime; unit and property tier (testing.mdc, tier 1).
Used by: pytest.
Uses: app/domain/note.py, hypothesis.
"""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from app.config import MAX_COMPOSE_SKEW_AHEAD_MS
from app.domain.note import Note, accept_write, clamp_composed_at, merge_note

notes = st.builds(
    Note, id=st.just("n"), text=st.text(max_size=8), composed_at=st.integers(0, 10**12)
)


class TestMergeNote:
    @given(notes, notes)
    def test_the_later_statement_wins_and_a_tie_goes_to_the_incoming_one(
        self, stored: Note, incoming: Note
    ) -> None:
        merged = merge_note(stored, incoming)
        assert merged.composed_at == max(stored.composed_at, incoming.composed_at)
        if stored.composed_at <= incoming.composed_at:
            assert merged == incoming

    @given(notes)
    def test_a_first_write_is_kept_as_is(self, incoming: Note) -> None:
        assert merge_note(None, incoming) == incoming


class TestClamp:
    @given(st.integers(0, 10**12), st.integers(0, 10**12))
    def test_a_stamp_never_ends_further_ahead_of_the_server_than_the_tolerance(
        self, composed_at: int, server_now: int
    ) -> None:
        clamped = clamp_composed_at(composed_at, server_now)
        assert clamped <= server_now + MAX_COMPOSE_SKEW_AHEAD_MS

    @given(st.integers(0, 10**12))
    def test_a_stamp_within_tolerance_is_kept(self, server_now: int) -> None:
        stamp = server_now + MAX_COMPOSE_SKEW_AHEAD_MS
        assert clamp_composed_at(stamp, server_now) == stamp

    @given(notes, st.integers(0, 10**12))
    def test_accept_write_is_idempotent_for_the_same_write(
        self, incoming: Note, server_now: int
    ) -> None:
        once = accept_write(None, incoming, server_now)
        assert accept_write(once, incoming, server_now) == once
