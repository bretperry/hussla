// A model of the remote, driven by a fault script: it merges like the real far side and breaks on command.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: NoteSyncChaosTests.swift.
// Uses: Domain.acceptWrite (the real merge rule), UseCases.Remote (implements it).
//
// Not a mock of HTTP: a model of behavior. It stores notes through the same `acceptWrite` the real
// far side runs, applies a write id at most once, and reads the clock the server would. So a test
// asserts the outcome (what the server holds, how often a write applied), not a call count.
// Faults are scripted by request index, so "the third request dies after the server applied it" is
// one line, and a failing run replays exactly.

import Domain
import UseCases

/// How a request breaks. The split that matters is whether the server applied the write first.
enum FaultKind: Equatable, Sendable, CaseIterable {
    /// The connection never reached the server; nothing applied.
    case dropBeforeApply
    /// The server applied the write and the answer was lost on the way back.
    case dropAfterApply
    /// The request takes `delay` in flight, then applies and answers.
    case delay
    /// A 5xx before anything is applied.
    case serverError
    /// A 4xx; the server will never accept this write.
    case refused
}

/// One scripted failure. `delay` is used by `.delay`, `status` by the two answers.
struct ServerFault: Equatable, Sendable {
    var kind: FaultKind
    var delay: Duration = .zero
    var status = 0
}

/// Picks the fault for a zero-based request index; nil answers normally.
typealias FaultScript = @Sendable (Int) -> ServerFault?

/// Plays `faults` on the first requests, then answers normally.
func first(_ faults: ServerFault...) -> FaultScript {
    let list = faults
    return { request in request < list.count ? list[request] : nil }
}

/// The model remote; it implements the `Remote` port.
actor FaultServer: Remote {
    private let nowMs: @Sendable () -> Int
    private let script: FaultScript
    private var notes: [String: Note] = [:]
    private var seen: Set<String> = []
    private(set) var requests = 0
    private(set) var applies = 0
    /// Requests that stopped because the client cancelled them (gave up waiting).
    private(set) var cancelledRequests = 0

    init(nowMs: @escaping @Sendable () -> Int, script: @escaping FaultScript = { _ in nil }) {
        self.nowMs = nowMs
        self.script = script
    }

    /// The real far side's write path: a write id applies once; the merge is the domain's.
    private func apply(_ entry: Entry) {
        guard seen.insert(entry.writeID).inserted else { return }
        applies += 1
        notes[entry.note.id] = acceptWrite(stored: notes[entry.note.id], incoming: entry.note, serverNowMs: nowMs())
    }

    private func nextFault() -> ServerFault? {
        defer { requests += 1 }
        return script(requests)
    }

    func put(_ entry: Entry) async -> Result<Void, RemoteFailure> {
        guard let fault = nextFault() else {
            apply(entry)
            return .success(())
        }
        switch fault.kind {
        case .dropBeforeApply:
            return .failure(.unreachable)
        case .dropAfterApply:
            apply(entry)
            return .failure(.unreachable)
        case .delay:
            // The request is in flight: the server applies it when it lands, even if the client has
            // given up by then. That late arrival is the case the write id exists for.
            let landing = Task { [weak self] in
                try? await Task.sleep(for: fault.delay)
                await self?.apply(entry)
            }
            do {
                try await Task.sleep(for: fault.delay)
            } catch {
                cancelledRequests += 1
                return .failure(.cancelled)
            }
            await landing.value
            return .success(())
        case .serverError, .refused:
            // Answered, nothing applied.
            return .failure(.status(fault.status))
        }
    }

    /// What the server holds for `id`.
    func note(_ id: String) -> Note? { notes[id] }
}
