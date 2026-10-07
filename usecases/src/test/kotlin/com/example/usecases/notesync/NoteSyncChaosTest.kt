/*
  Fault injection (tier 2, testing.mdc) for note-sync: one test per fault kind, plus a property over random fault scripts.
  In the app: nothing at runtime; runs in `./gradlew check` (pnpm kotlin:check) on every PR.
  Used by: JUnit 6 (Gradle's test task).
  Uses: usecases test fixtures (chaos: FaultServer, MemoryOutbox), kotlinx-coroutines-test (virtual time), kotest-property.

  Each test drives the real use-case against a model of the far side and asserts the outcome:
  what the server holds, how many times a write applied, what is still queued. Remove a handler
  from NoteSync and its test goes red; that is the bar for a tier-2 test. Time is virtual
  (runTest's scheduler), so a 10-minute delay costs nothing and a failure replays exactly
  (kotest prints the seed of a failing property run).
*/
// runTest's virtual-time controls (currentTime, advanceTimeBy) are still experimental.
@file:OptIn(ExperimentalCoroutinesApi::class)

package com.example.usecases.notesync

import com.example.config.SYNC_BACKOFF_BASE_MS
import com.example.config.SYNC_MAX_ATTEMPTS
import com.example.domain.Outcome
import com.example.usecases.chaos.Disk
import com.example.usecases.chaos.FaultScript
import com.example.usecases.chaos.FaultServer
import com.example.usecases.chaos.KillPoint
import com.example.usecases.chaos.MemoryOutbox
import com.example.usecases.chaos.OutboxFaults
import com.example.usecases.chaos.ProcessKilled
import com.example.usecases.chaos.RowState
import com.example.usecases.chaos.ServerFault
import com.example.usecases.chaos.firstRequests
import io.kotest.property.Arb
import io.kotest.property.arbitrary.bind
import io.kotest.property.arbitrary.choice
import io.kotest.property.arbitrary.constant
import io.kotest.property.arbitrary.list
import io.kotest.property.arbitrary.long
import io.kotest.property.arbitrary.map
import io.kotest.property.arbitrary.of
import io.kotest.property.arbitrary.string
import io.kotest.property.checkAll
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.EnumSource

// Wall-clock ms at virtual time 0, so stamps look like real ones.
private const val EPOCH_MS = 1_000_000_000_000L
private const val MINUTE_MS = 60_000L
private const val HOUR_MS = 60 * MINUTE_MS

// The server's clock: virtual time, never skewed.
private fun TestScope.serverClock(): () -> Long = { EPOCH_MS + currentTime }

private fun TestScope.server(script: FaultScript = FaultScript { null }) =
    FaultServer(serverClock(), backgroundScope, script)

// Write ids are unique across devices, as real ones (UUIDs) are; the server dedupes on them.
private var devices = 0

// One device: its own disk and outbox faults, talking to `server`. start() is a process (re)start.
private class Device(
    private val scope: TestScope,
    private val server: FaultServer,
    val faults: OutboxFaults = OutboxFaults(),
    private val skewMs: Long = 0,
) {
    val disk = Disk()
    private val name = "d${++devices}"
    private var ids = 0

    fun start() =
        NoteSync(
            outbox = MemoryOutbox(disk, faults),
            remote = server,
            clock = { EPOCH_MS + scope.currentTime + skewMs },
            newWriteId = { "$name-w${++ids}" },
        )
}

// Runs `work` on virtual time; returns its result and the virtual ms it took.
private suspend fun <T> TestScope.timed(work: suspend () -> T): Pair<T, Long> {
    val startedAt = currentTime
    val result = work()
    return result to currentTime - startedAt
}

class NoteSyncChaosTest {
    @Test
    fun `drop - retries a dropped request, and a write the server applied before the drop applies once`() =
        runTest {
            val server =
                server(firstRequests(ServerFault.DropBeforeApply, ServerFault.DropAfterApply))
            val phone = Device(this, server)
            val sync = phone.start()
            sync.save("n", "hello")
            assertEquals(FlushReport(delivered = 1), sync.flush())
            assertEquals(
                listOf("hello", 1, 3, 0),
                listOf(
                    server.note("n")?.text,
                    server.applies,
                    server.requests,
                    phone.disk.rows.size,
                ),
            )
        }

    @Test
    fun `delay - gives up on a hung request at the timeout, retries, and the late answer applies nothing twice`() =
        runTest {
            val server = server(firstRequests(ServerFault.Delay(10 * MINUTE_MS)))
            val phone = Device(this, server)
            val sync = phone.start()
            sync.save("n", "hello")
            val (report, tookMs) = timed { sync.flush() }
            assertEquals(FlushReport(delivered = 1), report)
            assertTrue(
                tookMs < MINUTE_MS,
                "flush took $tookMs ms of virtual time; the timeout should have cut the hung request",
            )
            // Let the hung request land on the server, late.
            advanceUntilIdle()
            assertEquals(
                listOf("hello", 1, 0),
                listOf(server.note("n")?.text, server.applies, phone.disk.rows.size),
            )
        }

    @Test
    fun `5xx - retries with backoff and delivers`() = runTest {
        val flaky =
            server(firstRequests(ServerFault.ServerError(503), ServerFault.ServerError(502)))
        val sync = Device(this, flaky).start()
        sync.save("n", "hello")
        val (report, tookMs) = timed { sync.flush() }
        assertEquals(FlushReport(delivered = 1), report)
        assertEquals(listOf("hello", 3), listOf(flaky.note("n")?.text, flaky.requests))
        // Two backoffs actually waited: the first step, then double it.
        assertTrue(
            tookMs >= SYNC_BACKOFF_BASE_MS * (1 + 2),
            "flush took $tookMs ms; the two backoffs alone are ${SYNC_BACKOFF_BASE_MS * 3}",
        )
    }

    @Test
    fun `5xx - past the attempt budget the write stays queued, not lost`() = runTest {
        val down = server { ServerFault.ServerError(503) }
        val phone = Device(this, down)
        val sync = phone.start()
        sync.save("n", "hello")
        assertEquals(FlushReport(requeued = 1), sync.flush())
        assertEquals(SYNC_MAX_ATTEMPTS, down.requests)
        assertEquals(listOf(RowState.PENDING), phone.disk.rows.map { it.state })
    }

    @Test
    fun `4xx - not retried, and parked rather than dropped`() = runTest {
        val server = server(firstRequests(ServerFault.Refused(400)))
        val phone = Device(this, server)
        val sync = phone.start()
        sync.save("n", "hello")
        assertEquals(FlushReport(refused = 1), sync.flush())
        assertEquals(1, server.requests)
        assertEquals(listOf(RowState.PARKED), phone.disk.rows.map { it.state })
    }

    @ParameterizedTest
    @EnumSource(KillPoint::class)
    fun `kill mid-write - the restarted process delivers the write exactly once`(kill: KillPoint) =
        runTest {
            val server = server()
            val phone = Device(this, server, OutboxFaults(kill = kill))
            phone.start().save("n", "hello")
            assertFailsWith<ProcessKilled> { phone.start().flush() }

            val restarted = phone.start()
            restarted.flush()
            assertEquals(
                listOf("hello", 1, 0),
                listOf(server.note("n")?.text, server.applies, phone.disk.rows.size),
            )
        }

    @Test
    fun `clock skew - a device an hour fast doesn't beat a later statement from an honest one`() =
        runTest {
            val server = server()
            val fast = Device(this, server, skewMs = HOUR_MS).start()
            val honest = Device(this, server).start()
            fast.save("n", "from the fast clock")
            fast.flush()
            advanceTimeBy(MINUTE_MS)
            honest.save("n", "said a minute later")
            honest.flush()
            assertEquals("said a minute later", server.note("n")?.text)
        }

    @Test
    fun `clock skew, the other way - a device an hour slow loses its later edit, and is told delivered`() =
        runTest {
            // Documents current behavior, not the goal: compose-time last-writer-wins can't tell a
            // slow clock from an old edit. docs/deferred.md → the Kotlin pack's slow-clock entry.
            // When that entry is taken, this test flips to expect the later edit.
            val server = server()
            val honest = Device(this, server).start()
            val slow = Device(this, server, skewMs = -HOUR_MS).start()
            honest.save("n", "said first")
            honest.flush()
            advanceTimeBy(MINUTE_MS)
            slow.save("n", "said a minute later")
            assertEquals(FlushReport(delivered = 1), slow.flush())
            assertEquals("said first", server.note("n")?.text)
        }

    @Test
    fun `full disk - the save is refused as Full, nothing half-saved or sent, and it works once space is back`() =
        runTest {
            val server = server()
            val phone = Device(this, server, OutboxFaults(full = true))
            val sync = phone.start()
            assertEquals(Outcome.Err(StorageError.Full), sync.save("n", "hello"))
            sync.flush()
            assertEquals(listOf(0, 0), listOf(phone.disk.rows.size, server.requests))
            assertNull(server.note("n"))

            phone.faults.full = false
            assertIs<Outcome.Ok<*>>(sync.save("n", "hello"))
            sync.flush()
            assertEquals("hello", server.note("n")?.text)
        }

    @Test
    fun `a quick answer cancels the request timeout, leaving no timer behind`() = runTest {
        val sync = Device(this, server()).start()
        sync.save("n", "hello")
        sync.flush()
        // A timer still pending would move virtual time forward here.
        advanceUntilIdle()
        assertEquals(0, currentTime)
    }

    @Test
    fun `overlapping flushes share one run, so nothing is sent twice`() = runTest {
        val server = server(firstRequests(ServerFault.Delay(1_000)))
        val sync = Device(this, server).start()
        sync.save("n", "hello")
        val first = async { sync.flush() }
        val second = async { sync.flush() }
        assertEquals(first.await(), second.await())
        assertEquals(listOf(1, 1), listOf(server.requests, server.applies))
    }

    @Test
    fun `under a random fault script, every save lands exactly once and each note ends as its last statement`() =
        runTest {
            val anyFault: Arb<ServerFault?> =
                Arb.choice(
                    Arb.constant(null),
                    Arb.of(ServerFault.DropBeforeApply, ServerFault.DropAfterApply),
                    Arb.long(1L..20_000L).map { ServerFault.Delay(it) },
                    Arb.of(500, 502, 503).map { ServerFault.ServerError(it) },
                )
            val anySave =
                Arb.bind(Arb.of("a", "b", "c"), Arb.string(maxSize = 8)) { id, text -> id to text }

            // checkAll's block runs with the property as `this`; the test scope drives virtual
            // time.
            val test = this
            checkAll(
                60,
                Arb.list(anyFault, 0..12),
                Arb.list(anySave, 1..6),
            ) { faults, saves ->
                val server = test.server { request -> faults.getOrNull(request) }
                val phone = Device(test, server)
                val sync = phone.start()
                for ((id, text) in saves) {
                    sync.save(id, text)
                    test.advanceTimeBy(1)
                }
                // Enough flushes to outlast the script: each one gives every write the full attempt
                // budget.
                repeat(5) { if (phone.disk.rows.isNotEmpty()) sync.flush() }
                test.advanceUntilIdle()

                assertEquals(0, phone.disk.rows.size)
                assertEquals(saves.size, server.applies)
                for ((id, text) in saves.toMap()) assertEquals(text, server.note(id)?.text)
            }
        }
}
