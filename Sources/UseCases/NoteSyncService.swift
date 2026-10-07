// Saves notes to a local outbox and delivers them to the remote, surviving drops, delays, 5xx, crashes, and a full disk.
// In the app: the write path for notes; a UI or API calls `save`, a timer or reconnect calls `flush`.
// Used by: its tests (the template's tier-2 seed has no production caller yet).
// Uses: Ports.swift (outbox, remote, time), Config (retry knobs), Domain (failures, Outcome).
//
// Each fault has one handler here, and a fault-injection test that fails without it
// (Tests/NoteSyncTests/NoteSyncChaosTests.swift): full disk -> `save` throws StorageFailure.full;
// drop (unreachable) -> retried; delay -> timed out, cancelled, and retried; 5xx -> retried with
// backoff, then left queued; kill mid-write -> the next flush releases dead claims. A fast clock is
// clamped on the far side (Domain.acceptWrite); a slow clock's later edit still loses
// (docs/deferred.md -> Swift pack: a slow clock's later edit loses).

import Config
import Domain

/// What one flush did with each write it tried.
public struct FlushReport: Equatable, Sendable {
    public var delivered = 0
    public var refused = 0
    public var requeued = 0

    public init(delivered: Int = 0, refused: Int = 0, requeued: Int = 0) {
        self.delivered = delivered
        self.refused = refused
        self.requeued = requeued
    }
}

/// The NoteSync use-case over its ports.
public actor NoteSyncService {
    private let outbox: any Outbox
    private let remote: any Remote
    private let time: any TimeSource
    private let policy: SyncPolicy
    private let makeWriteID: @Sendable () -> String
    private var inFlight: Task<FlushReport, any Error>?

    public init(
        outbox: any Outbox,
        remote: any Remote,
        time: any TimeSource,
        policy: SyncPolicy = .standard,
        makeWriteID: @escaping @Sendable () -> String
    ) {
        self.outbox = outbox
        self.remote = remote
        self.time = time
        self.policy = policy
        self.makeWriteID = makeWriteID
    }

    /// Stamps and queues a note. Nothing is sent here, so a save works offline.
    /// A full disk throws `StorageFailure.full`.
    @discardableResult
    public func save(id: String, text: String) async throws -> Note {
        let note = Note(id: id, text: text, composedAtMs: time.nowMs())
        try await outbox.append(Entry(writeID: makeWriteID(), note: note))
        return note
    }

    /// Sends every queued write once through the retry budget; what is still failing stays queued.
    ///
    /// Single-flight: a call while one runs gets the running one's report. Two at once would both
    /// send the same writes, and the second's `releaseClaims` would un-claim the first's in-flight row.
    /// A started flush runs to completion; it is not tied to the caller that started it.
    public func flush() async throws -> FlushReport {
        if let running = inFlight {
            return try await running.value
        }
        let run = Task { try await self.flushOnce() }
        inFlight = run
        defer { inFlight = nil }
        return try await run.value
    }

    /// What one request came to: an answer, or no answer in time.
    private enum Attempt: Sendable {
        case answered(Result<Void, RemoteFailure>)
        case timedOut
    }

    /// Sends one request, bounded by the timeout. No answer in time counts as transient; the hung
    /// request is cancelled the moment the timeout wins, so nothing is left waiting. A timed-out
    /// request's late answer is ignored; the write id makes the retry a no-op if it did apply.
    private func attempt(_ entry: Entry) async throws -> Outcome {
        let remote = self.remote
        let time = self.time
        let timeout = policy.requestTimeout
        let first = await withTaskGroup(of: Attempt?.self, returning: Attempt?.self) { group in
            group.addTask { .answered(await remote.put(entry)) }
            group.addTask {
                do {
                    try await time.sleep(for: timeout)
                    return .timedOut
                } catch {
                    return nil
                }
            }
            var winner: Attempt?
            while let next = await group.next() {
                if let decided = next {
                    winner = decided
                    break
                }
            }
            group.cancelAll()
            return winner
        }
        // The caller's own cancellation is not a remote failure: stop, don't retry into it.
        try Task.checkCancellation()
        switch first {
        case .answered(let result): return outcome(of: result)
        case .timedOut, nil: return .transient
        }
    }

    /// Tries one write up to the attempt budget, backing off between tries.
    private func deliver(_ entry: Entry) async throws -> Outcome {
        var tried = 1
        while true {
            let result = try await attempt(entry)
            if result != .transient || tried >= policy.maxAttempts { return result }
            try await time.sleep(for: policy.backoffBase * (1 << (tried - 1)))
            tried += 1
        }
    }

    /// One pass over the outbox: dead claims back to pending first (a process killed mid-flush left them).
    private func flushOnce() async throws -> FlushReport {
        var report = FlushReport()
        try await outbox.releaseClaims()
        for entry in try await outbox.pending() {
            try await outbox.claim(entry.writeID)
            let result = try await deliver(entry)
            try await settle(entry, as: result, into: &report)
        }
        return report
    }

    /// Records what became of a write: removed, parked, or back in the queue, and counts it in the
    /// report. If the outbox throws, the flush throws and its report is never seen.
    private func settle(_ entry: Entry, as result: Outcome, into report: inout FlushReport) async throws {
        switch result {
        case .applied:
            try await outbox.remove(entry.writeID)
            report.delivered += 1
        case .refused:
            try await outbox.park(entry.writeID)
            report.refused += 1
        case .transient:
            try await outbox.release(entry.writeID)
            report.requeued += 1
        }
    }
}
