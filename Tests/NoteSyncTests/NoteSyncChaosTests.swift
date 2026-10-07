// Fault injection (tier 2, testing.mdc) for NoteSync: one test per fault kind, plus a property over random fault scripts.
// In the app: nothing at runtime; runs in plain `swift test` on every PR (no flag, trait, or env var hides it).
// Used by: swift test.
// Uses: Tests/NoteSyncTests/Chaos (fault-script server, in-memory outbox, device), UseCases, Domain, Config.
//
// Each test drives the real use-case against a model of the far side and asserts the outcome: what
// the server holds, how many times a write applied, what is still queued. Remove a handler from
// NoteSyncService.swift and its test goes red; that is the bar for a tier-2 test. Time is real but
// short (`quickPolicy`: 100 ms timeout, 20 ms backoff), with wide margins, and a test that waits on
// a clock only asserts a lower bound (a backoff happened) or a generous upper one (a hung request was
// abandoned, not waited out). The random-script test prints its seed, so a failure replays.

import Config
import Domain
import Foundation
import Testing
import UseCases

private let hour = 3_600_000

/// A server on the real clock.
private func makeServer(_ script: @escaping FaultScript = { _ in nil }) -> FaultServer {
    FaultServer(nowMs: { Int(Date().timeIntervalSince1970 * 1000) }, script: script)
}

/// Runs one flush; returns its report and how long it took.
private func timedFlush(_ service: NoteSyncService) async throws -> (report: FlushReport, took: Duration) {
    let clock = ContinuousClock()
    let started = clock.now
    let report = try await service.flush()
    return (report, clock.now - started)
}

private func pause(_ duration: Duration) async throws { try await Task.sleep(for: duration) }

@Suite("Fault injection: NoteSync")
struct NoteSyncChaosTests {
    @Test("drop: retries a dropped request, and a write the server applied before the drop applies once")
    func drop() async throws {
        let server = makeServer(first(ServerFault(kind: .dropBeforeApply), ServerFault(kind: .dropAfterApply)))
        let phone = Device()
        let service = phone.start(remote: server)
        try await service.save(id: "n", text: "hello")
        let flushed = try await timedFlush(service)
        #expect(flushed.report == FlushReport(delivered: 1))
        #expect(await server.note("n")?.text == "hello")
        #expect(await server.applies == 1)
        #expect(await server.requests == 3)
        #expect(await phone.states() == [])
    }

    @Test("delay: gives up on a hung request at the timeout, cancels it, retries, and the late landing applies nothing twice")
    func delay() async throws {
        // The first request hangs for 1.5 s; the timeout is 100 ms.
        let server = makeServer(first(ServerFault(kind: .delay, delay: .milliseconds(1500))))
        let phone = Device()
        let service = phone.start(remote: server)
        try await service.save(id: "n", text: "hello")
        let flushed = try await timedFlush(service)
        #expect(flushed.report == FlushReport(delivered: 1))
        #expect(flushed.took < .milliseconds(1000), "flush took \(flushed.took): it waited out the hung request instead of timing out")
        #expect(await server.cancelledRequests == 1)
        // Let the first request land, 1.5 s after it was sent: the write id makes it a no-op.
        try await pause(.milliseconds(1700))
        #expect(await server.note("n")?.text == "hello")
        #expect(await server.applies == 1)
        #expect(await phone.states() == [])
    }

    @Test("5xx: retries with backoff and delivers")
    func serverErrorRetries() async throws {
        let server = makeServer(first(ServerFault(kind: .serverError, status: 503), ServerFault(kind: .serverError, status: 502)))
        let service = Device().start(remote: server)
        try await service.save(id: "n", text: "hello")
        let flushed = try await timedFlush(service)
        #expect(flushed.report == FlushReport(delivered: 1))
        #expect(await server.note("n")?.text == "hello")
        #expect(await server.requests == 3)
        // Two backoffs actually waited: the first step, then double it.
        #expect(
            flushed.took >= quickPolicy.backoffBase * 3,
            "flush took \(flushed.took), want at least \(quickPolicy.backoffBase * 3) of backoff")
    }

    @Test("5xx: past the attempt budget the write stays queued, not lost")
    func serverErrorBudget() async throws {
        // Down for three budgets' worth of requests, then up: a flush that ignored its budget would
        // keep going and deliver, which this test counts as a failure.
        let budget = quickPolicy.maxAttempts
        let server = makeServer { request in request < 3 * budget ? ServerFault(kind: .serverError, status: 503) : nil }
        let phone = Device()
        let service = phone.start(remote: server)
        try await service.save(id: "n", text: "hello")
        let flushed = try await timedFlush(service)
        #expect(flushed.report == FlushReport(requeued: 1))
        #expect(await server.requests == budget)
        #expect(await phone.states() == [.pending])
    }

    @Test("4xx, 5xx's neighbour: not retried, and parked rather than dropped")
    func refusedIsParked() async throws {
        let server = makeServer(first(ServerFault(kind: .refused, status: 400)))
        let phone = Device()
        let service = phone.start(remote: server)
        try await service.save(id: "n", text: "hello")
        let flushed = try await timedFlush(service)
        #expect(flushed.report == FlushReport(refused: 1))
        #expect(await server.requests == 1)
        #expect(await phone.states() == [.parked])
    }

    @Test(
        "kill mid-write: the restarted process delivers the write exactly once", arguments: [KillPoint.afterClaim, KillPoint.beforeRemove])
    func killMidWrite(point: KillPoint) async throws {
        let server = makeServer()
        let phone = Device(kill: point)
        try await phone.start(remote: server).save(id: "n", text: "hello")

        await #expect(throws: ProcessKilled(point: point)) { try await phone.start(remote: server).flush() }

        // The restart: a new process over the same disk, with the claim the dead one left behind.
        let restarted = phone.start(remote: server)
        _ = try await restarted.flush()
        #expect(await server.note("n")?.text == "hello")
        #expect(await server.applies == 1)
        #expect(await phone.states() == [])
    }

    @Test("clock skew: a device an hour fast doesn't beat a later statement from an honest one")
    func fastClockIsClamped() async throws {
        let server = makeServer()
        let fast = Device(skewMs: hour).start(remote: server)
        let honest = Device().start(remote: server)
        try await fast.save(id: "n", text: "from the fast clock")
        _ = try await fast.flush()
        try await pause(.milliseconds(50))
        try await honest.save(id: "n", text: "said a bit later")
        _ = try await honest.flush()
        #expect(await server.note("n")?.text == "said a bit later")
    }

    @Test("clock skew, the other way: a device an hour slow loses its later edit, and is told delivered")
    func slowClockLoses() async throws {
        // Documents current behavior, not the goal: compose-time last-writer-wins can't tell a slow
        // clock from an old edit. docs/deferred.md -> "Swift pack: a slow clock's later edit loses".
        // When that entry is taken, this test flips to expect the later edit.
        let server = makeServer()
        let honest = Device().start(remote: server)
        let slow = Device(skewMs: -hour).start(remote: server)
        try await honest.save(id: "n", text: "said first")
        _ = try await honest.flush()
        try await pause(.milliseconds(50))
        try await slow.save(id: "n", text: "said a bit later")
        let flushed = try await timedFlush(slow)
        #expect(flushed.report == FlushReport(delivered: 1))
        #expect(await server.note("n")?.text == "said first")
    }

    @Test("full disk: the save is refused as storage-full, nothing half-saved or sent; it works once space is back")
    func fullDisk() async throws {
        let server = makeServer()
        let phone = Device(full: true)
        let service = phone.start(remote: server)
        await #expect(throws: StorageFailure.full) { try await service.save(id: "n", text: "hello") }
        _ = try await service.flush()
        #expect(await phone.states() == [])
        #expect(await server.requests == 0)
        #expect(await server.note("n") == nil)

        await phone.faults.setFull(false)
        try await service.save(id: "n", text: "hello")
        _ = try await service.flush()
        #expect(await server.note("n")?.text == "hello")
    }

    @Test("overlapping flushes share one run, so nothing is sent twice")
    func singleFlight() async throws {
        let server = makeServer(first(ServerFault(kind: .delay, delay: .milliseconds(300))))
        let slowTimeout = SyncPolicy(maxAttempts: 4, backoffBase: .milliseconds(20), requestTimeout: .seconds(5))
        let service = Device().start(remote: server, policy: slowTimeout)
        try await service.save(id: "n", text: "hello")

        let firstCall = Task { try await service.flush() }
        // The second caller must arrive while the first is still waiting on the delayed request.
        try await pause(.milliseconds(100))
        let secondCall = Task { try await service.flush() }
        let reports = try await [firstCall.value, secondCall.value]
        #expect(await server.requests == 1)
        #expect(await server.applies == 1)
        #expect(reports[0] == reports[1])
    }
}

/// One random script: what the server does to each request, and which notes get saved.
private struct Scenario {
    var script: [ServerFault?]
    var saves: [(id: String, text: String)]

    /// Draws a scenario from `generator`: up to 12 scripted requests, 1 to 6 saves over three notes.
    init(generator: inout SplitMix64) {
        script = (0..<Int.random(in: 0...12, using: &generator)).map { _ in
            switch Int.random(in: 0...4, using: &generator) {
            case 0: return nil
            case 1: return ServerFault(kind: .dropBeforeApply)
            case 2: return ServerFault(kind: .dropAfterApply)
            // Fast enough to land inside the timeout, or slow enough to be abandoned.
            case 3: return ServerFault(kind: .delay, delay: Bool.random(using: &generator) ? .milliseconds(2) : .milliseconds(120))
            default: return ServerFault(kind: .serverError, status: [500, 502, 503].randomElement(using: &generator) ?? 500)
            }
        }
        saves = (0..<Int.random(in: 1...6, using: &generator)).map { index in
            (["a", "b", "c"].randomElement(using: &generator) ?? "a", "text \(index) \(UInt8.random(in: 0...255, using: &generator))")
        }
    }
}

@Suite("Fault injection: random scripts")
struct RandomFaultScriptTests {
    /// How many seeds one run tries; raise it for a soak, never lower it to hide a failure.
    private static let seeds: UInt64 = 60

    /// Tighter than `quickPolicy` (40 ms timeout, 2 ms backoff) so 60 scripts finish in seconds.
    private static let policy = SyncPolicy(maxAttempts: 4, backoffBase: .milliseconds(2), requestTimeout: .milliseconds(40))

    @Test("whatever the script, every write is delivered exactly once and each note ends on its last statement")
    func nothingLostNothingTwice() async throws {
        for seed in 0..<Self.seeds {
            var generator = SplitMix64(seed: seed)
            let scenario = Scenario(generator: &generator)
            let script = scenario.script
            let server = makeServer { request in request < script.count ? script[request] : nil }
            let phone = Device()
            let service = phone.start(remote: server, policy: Self.policy)
            var last: [String: String] = [:]
            for save in scenario.saves {
                try await service.save(id: save.id, text: save.text)
                last[save.id] = save.text
                // Distinct stamps, so "last statement" is well defined.
                try await pause(.milliseconds(3))
            }
            // Enough flushes to outlast the script: each one gives every write the full attempt budget.
            for _ in 0..<5 where !(await phone.states()).isEmpty {
                _ = try await service.flush()
            }
            // Let any hung request land before counting (only a script with one needs the wait).
            if script.contains(where: { $0?.delay == .milliseconds(120) }) { try await pause(.milliseconds(150)) }

            #expect(await phone.states() == [], "seed \(seed): writes still queued")
            #expect(await server.applies == scenario.saves.count, "seed \(seed): a write was lost or applied twice")
            for (id, text) in last {
                #expect(await server.note(id)?.text == text, "seed \(seed): note \(id) is not its last statement")
            }
        }
    }
}
