// An in-memory outbox with a fault script: a full disk, or the process killed at a chosen step.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: NoteSyncChaosTests.swift.
// Uses: UseCases.Outbox (implements it), Domain.StorageFailure.
//
// The rows live in a `Disk` the test keeps, so "restart the process" is a new outbox over the same
// disk. Every step is atomic, like a transactional store: a kill lands between steps, never
// inside one, which is what a kill is to a store with a journal.

import Domain
import UseCases

/// Where a queued write stands.
enum RowState: Equatable, Sendable {
    case pending
    case claimed
    case parked
}

/// One write on the disk.
struct Row: Equatable, Sendable {
    var entry: Entry
    var state: RowState
}

/// What survives a process: the rows, in append order.
actor Disk {
    private(set) var rows: [Row] = []

    func append(_ entry: Entry) { rows.append(Row(entry: entry, state: .pending)) }

    func setState(_ writeID: String, _ state: RowState) throws {
        guard let index = rows.firstIndex(where: { $0.entry.writeID == writeID }) else {
            throw MissingRow(writeID: writeID)
        }
        rows[index].state = state
    }

    func releaseClaims() {
        for index in rows.indices where rows[index].state == .claimed { rows[index].state = .pending }
    }

    func remove(_ writeID: String) { rows.removeAll { $0.entry.writeID == writeID } }
}

/// A caller named a write the disk doesn't hold: a bug, never an expected failure.
struct MissingRow: Error { var writeID: String }

/// Where a kill can land: after a claim commits (nothing sent yet), or after the send and before
/// the remove commits (the server has it; the outbox doesn't know).
enum KillPoint: Equatable, Sendable, CustomStringConvertible {
    case afterClaim
    case beforeRemove

    var description: String {
        switch self {
        case .afterClaim: return "after-claim"
        case .beforeRemove: return "before-remove"
        }
    }
}

/// What "the process" throws when the script kills it; a test expects exactly this.
struct ProcessKilled: Error, Equatable { var point: KillPoint }

/// The faults an outbox can play: refuse appends (full disk), or kill the process once at a point.
/// The outbox reads it on every call, so a test can change it mid-run.
actor OutboxFaults {
    var full: Bool
    private var kill: KillPoint?

    init(full: Bool = false, kill: KillPoint? = nil) {
        self.full = full
        self.kill = kill
    }

    func setFull(_ value: Bool) { full = value }

    /// Dies here if the script says so, once; the restarted process runs clean.
    func killIfScripted(at point: KillPoint) throws {
        guard kill == point else { return }
        kill = nil
        throw ProcessKilled(point: point)
    }
}

/// An outbox over `disk`.
struct MemoryOutbox: Outbox {
    let disk: Disk
    let faults: OutboxFaults

    func append(_ entry: Entry) async throws {
        if await faults.full { throw StorageFailure.full }
        await disk.append(entry)
    }

    func pending() async throws -> [Entry] {
        await disk.rows.filter { $0.state == .pending }.map(\.entry)
    }

    func claim(_ writeID: String) async throws {
        try await disk.setState(writeID, .claimed)
        try await faults.killIfScripted(at: .afterClaim)
    }

    func release(_ writeID: String) async throws { try await disk.setState(writeID, .pending) }

    func releaseClaims() async throws { await disk.releaseClaims() }

    func remove(_ writeID: String) async throws {
        try await faults.killIfScripted(at: .beforeRemove)
        await disk.remove(writeID)
    }

    func park(_ writeID: String) async throws { try await disk.setState(writeID, .parked) }
}
