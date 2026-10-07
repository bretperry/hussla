// Knobs for delivering notes to the remote: retry budget, backoff, request timeout, and clock-skew tolerance.
// In the app: read by the NoteSync use-case and the note merge rule; retune here, never inline.
// Used by: UseCases/NoteSyncService.swift, Domain/Note.swift, the tests (which pass a faster SyncPolicy).
// Uses: nothing; this layer imports no module (swift-layers.json).

/// How one flush retries a write; a test passes a faster one so a 5 s timeout doesn't cost 5 s.
public struct SyncPolicy: Sendable, Equatable {
    /// How many times one flush tries a write before leaving it queued for the next flush.
    public var maxAttempts: Int
    /// The first retry's wait; each later one doubles it.
    public var backoffBase: Duration
    /// Bounds one request: no answer by then is treated as dropped and retried (the write id keeps the retry a no-op).
    public var requestTimeout: Duration

    public init(maxAttempts: Int, backoffBase: Duration, requestTimeout: Duration) {
        self.maxAttempts = maxAttempts
        self.backoffBase = backoffBase
        self.requestTimeout = requestTimeout
    }

    /// What the product ships with.
    public static let standard = SyncPolicy(maxAttempts: 4, backoffBase: .milliseconds(500), requestTimeout: .seconds(5))
}

/// How far past the server's clock a stamp may be before it is clamped to the server's clock, so a
/// device whose clock runs fast can't win every later comparison.
public let maxComposeSkewAhead: Duration = .seconds(30)

extension Duration {
    /// Whole milliseconds, rounded down: the unit a note's stamp is kept in.
    public var wholeMilliseconds: Int {
        let parts = components
        return Int(parts.seconds) * 1000 + Int(parts.attoseconds / 1_000_000_000_000_000)
    }
}
