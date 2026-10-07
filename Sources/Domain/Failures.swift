// The expected failures of delivering a note, and what one delivery attempt amounted to.
// In the app: ports return these as values; the use-case switches on an Outcome to remove, park, or requeue a write.
// Used by: UseCases/NoteSyncService.swift, the test fakes.
// Uses: nothing.
//
// Expected failures are values: `Remote.put` returns a `Result<Void, RemoteFailure>`, so a caller
// can't forget one. Anything an adapter throws is a bug and surfaces to the top, loud. A `switch`
// over these enums names every case and never has a `default:` (the compiler checks exhaustiveness;
// boundaries.mjs rejects the `default:` that would defeat it), so adding a case can't leave one unhandled.

/// How the remote answered, when it did not succeed.
public enum RemoteFailure: Error, Equatable, Sendable {
    /// No answer: a dropped connection, not a refusal.
    case unreachable
    /// An answer that was not success.
    case status(Int)
    /// The request was cancelled (the client gave up waiting).
    case cancelled
}

/// The outbox's disk can't take another write; nothing was half-written.
public enum StorageFailure: Error, Equatable, Sendable {
    case full
}

/// What an attempt to deliver a write came to.
public enum Outcome: Equatable, Sendable {
    /// The remote has the write.
    case applied
    /// The remote will never accept it, so retrying is pointless.
    case refused
    /// It may pass next time (no answer, timeout, 5xx).
    case transient
}

/// Classifies what the remote returned. A 5xx may pass later; a 4xx never will.
public func outcome(of result: Result<Void, RemoteFailure>) -> Outcome {
    switch result {
    case .success:
        return .applied
    case .failure(let failure):
        switch failure {
        case .unreachable, .cancelled:
            return .transient
        case .status(let code):
            return code >= 500 ? .transient : .refused
        }
    }
}
