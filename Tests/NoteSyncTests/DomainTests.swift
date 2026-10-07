// Unit tests (tier 1) for the note merge rule, and the Outcome classification.
// In the app: nothing at runtime; runs in `swift test` on every PR.
// Used by: swift test.
// Uses: Domain (the code under test), Config (the skew knob).

import Config
import Domain
import Testing

@Suite("Note merge")
struct NoteMergeTests {
    private func note(_ text: String, at stamp: Int) -> Note { Note(id: "n", text: text, composedAtMs: stamp) }

    @Test("the later statement wins, whichever arrives first")
    func laterWins() {
        let early = note("early", at: 100)
        let late = note("late", at: 200)
        #expect(merge(stored: early, incoming: late) == late)
        #expect(merge(stored: late, incoming: early) == late)
    }

    @Test("a tie goes to the incoming write, and no stored note means the incoming one is kept")
    func tieAndEmpty() {
        let stored = note("stored", at: 100)
        let incoming = note("incoming", at: 100)
        #expect(merge(stored: stored, incoming: incoming) == incoming)
        #expect(merge(stored: nil, incoming: incoming) == incoming)
    }

    @Test("merging is idempotent and order-independent for distinct stamps (a law over many stamp pairs)")
    func mergeLaws() {
        var generator = SplitMix64(seed: 7)
        for _ in 0..<500 {
            let first = note("a", at: Int(generator.next() % 10_000))
            let second = note("b", at: Int(generator.next() % 10_000) + 10_000)
            #expect(
                merge(stored: merge(stored: nil, incoming: first), incoming: second)
                    == merge(stored: merge(stored: nil, incoming: second), incoming: first))
            #expect(merge(stored: first, incoming: first) == first)
        }
    }

    @Test("a stamp past the skew tolerance is clamped to the server's clock; one inside it is kept")
    func clamp() {
        let maxAhead = maxComposeSkewAhead.wholeMilliseconds
        #expect(clampComposedAt(1_000 + maxAhead + 1, serverNowMs: 1_000, maxAheadMs: maxAhead) == 1_000)
        #expect(clampComposedAt(1_000 + maxAhead, serverNowMs: 1_000, maxAheadMs: maxAhead) == 1_000 + maxAhead)
        #expect(clampComposedAt(5, serverNowMs: 1_000, maxAheadMs: maxAhead) == 5)
    }
}

@Suite("Outcome")
struct OutcomeTests {
    @Test("each expected failure classifies, and a 4xx is never retried while a 5xx is")
    func classification() {
        #expect(outcome(of: .success(())) == .applied)
        #expect(outcome(of: .failure(.unreachable)) == .transient)
        #expect(outcome(of: .failure(.cancelled)) == .transient)
        #expect(outcome(of: .failure(.status(503))) == .transient)
        #expect(outcome(of: .failure(.status(400))) == .refused)
    }
}

/// A small seeded generator, so a property test replays: no dependency, and the seed is in the failure message.
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var mixed = state
        mixed = (mixed ^ (mixed >> 30)) &* 0xBF58_476D_1CE4_E5B9
        mixed = (mixed ^ (mixed >> 27)) &* 0x94D0_49BB_1331_11EB
        return mixed ^ (mixed >> 31)
    }
}
