// The device's real clock and timer, behind the TimeSource port.
// In the app: the composition root hands it to NoteSyncService.
// Used by: the app's composition root (none in this seed); the tests wrap it to skew `nowMs`.
// Uses: Foundation (wall time), UseCases (the port), the standard library's Task.sleep.

import Foundation
import UseCases

/// Wall time from the system clock, and waiting on the real timer (cancellable).
public struct SystemTime: TimeSource {
    public init() {}

    public func nowMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    public func sleep(for duration: Duration) async throws {
        try await Task.sleep(for: duration)
    }
}
