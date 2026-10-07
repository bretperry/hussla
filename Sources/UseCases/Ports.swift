// The ports the NoteSync use-case depends on: a local outbox, the remote it delivers to, and time.
// In the app: contracts only; an adapter per vendor implements each, wired in the composition root.
// Used by: NoteSyncService.swift; Adapters/SystemTime.swift; the fakes in Tests/NoteSyncTests/Chaos.
// Uses: Domain types only (ports are contracts: docs/ports-and-adapters.md).
//
// The outbox is durable: a write is in it before anything is sent, so a crash never loses a save.
// A claim marks a write as in flight, and is persisted, which is why a process killed mid-flush
// leaves claims behind that the next flush must release.

import Domain

/// One queued write: the note as stated, and the id that makes delivering it twice a no-op.
public struct Entry: Equatable, Sendable {
    public let writeID: String
    public let note: Note

    public init(writeID: String, note: Note) {
        self.writeID = writeID
        self.note = note
    }
}

/// The durable local queue. Any error other than the ones named is a bug.
public protocol Outbox: Sendable {
    /// Persists a write; throws `StorageFailure.full` when the disk can't take it (nothing is half-written).
    func append(_ entry: Entry) async throws
    /// Lists writes waiting to be sent, oldest first; claimed ones are not included.
    func pending() async throws -> [Entry]
    /// Marks a write in flight.
    func claim(_ writeID: String) async throws
    /// Puts a write back in the queue for a later flush.
    func release(_ writeID: String) async throws
    /// Puts every claimed write back: claims left by a process that died mid-flush.
    func releaseClaims() async throws
    /// Drops a write the remote applied.
    func remove(_ writeID: String) async throws
    /// Sets aside a write the remote refused for a reason a retry won't fix: out of the queue, but
    /// kept for a person to look at, so a refusal never silently loses a save.
    func park(_ writeID: String) async throws
}

/// The far side. It applies a write id at most once, so resending is always safe.
public protocol Remote: Sendable {
    /// Sends one write. It must return promptly when its task is cancelled: that is how the use-case
    /// stops waiting on a hung request. Expected failures come back as values.
    func put(_ entry: Entry) async -> Result<Void, RemoteFailure>
}

/// Wall time and waiting, so a test can skew one and speed up the other.
public protocol TimeSource: Sendable {
    /// Wall-clock milliseconds since 1970; it may be wrong (skewed), which the far side's merge rule allows for.
    func nowMs() -> Int
    /// Waits `duration`, or throws `CancellationError` as soon as the task is cancelled.
    func sleep(for duration: Duration) async throws
}
