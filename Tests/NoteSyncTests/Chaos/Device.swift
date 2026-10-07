// One phone for a test: its own disk, outbox faults, and clock skew, talking to a server.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: NoteSyncChaosTests.swift.
// Uses: Adapters.SystemTime (the real clock, wrapped to skew it), the other fakes in this folder.

import Adapters
import Config
import Foundation
import UseCases

/// The device's clock: `skewMs` off true time for `nowMs`, the real timer for `sleep`.
struct SkewedTime: TimeSource {
    var skewMs: Int
    private let real = SystemTime()

    init(skewMs: Int = 0) { self.skewMs = skewMs }

    func nowMs() -> Int { real.nowMs() + skewMs }

    func sleep(for duration: Duration) async throws { try await real.sleep(for: duration) }
}

/// A faster policy, so a test's timeout and backoff cost milliseconds. Margins stay wide (the
/// timeout is 25 times the shortest delay a test calls "fast") so a loaded runner doesn't flip a result.
let quickPolicy = SyncPolicy(maxAttempts: 4, backoffBase: .milliseconds(20), requestTimeout: .milliseconds(100))

/// Numbers devices, so write ids are unique across them as real ones (UUIDs) are; the server dedupes on them.
private let deviceNumbers = Counter()

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}

/// A phone: a disk that outlives processes, and `start(...)` for a process (re)start.
final class Device: @unchecked Sendable {
    let disk = Disk()
    let faults: OutboxFaults
    let skewMs: Int
    private let name = "d\(deviceNumbers.next())"
    private let ids = Counter()

    init(skewMs: Int = 0, full: Bool = false, kill: KillPoint? = nil) {
        self.skewMs = skewMs
        self.faults = OutboxFaults(full: full, kill: kill)
    }

    /// A process start over this device's disk.
    func start(remote: any Remote, policy: SyncPolicy = quickPolicy) -> NoteSyncService {
        let name = self.name
        let ids = self.ids
        return NoteSyncService(
            outbox: MemoryOutbox(disk: disk, faults: faults),
            remote: remote,
            time: SkewedTime(skewMs: skewMs),
            policy: policy,
            makeWriteID: { "\(name)-w\(ids.next())" }
        )
    }

    /// Each queued row's state, oldest first.
    func states() async -> [RowState] { await disk.rows.map(\.state) }
}
