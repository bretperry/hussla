/*
  The note merge rule's laws, as properties: later wins, merging is idempotent, only a fast stamp is clamped.
  In the app: nothing at runtime; runs in `./gradlew check` (pnpm kotlin:check).
  Used by: JUnit 6 (Gradle's test task).
  Uses: kotest-property (generated inputs; a failing run prints its seed).
*/
package com.example.domain

import com.example.config.MAX_COMPOSE_SKEW_AHEAD_MS
import io.kotest.property.Arb
import io.kotest.property.arbitrary.bind
import io.kotest.property.arbitrary.long
import io.kotest.property.arbitrary.string
import io.kotest.property.checkAll
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest

// Stamps around a fixed server time, so both sides of the clamp are reached.
private const val SERVER_NOW = 1_000_000_000_000L
private val anyStamp = Arb.long(SERVER_NOW - 3_600_000L..SERVER_NOW + 3_600_000L)
private val anyNote =
    Arb.bind(Arb.string(maxSize = 4), Arb.string(maxSize = 8), anyStamp) { id, text, at ->
        Note(id, text, at)
    }

class NoteTest {
    @Test
    fun `the later statement wins, and a tie goes to the incoming one`() = runTest {
        checkAll(anyNote, anyNote) { stored, incoming ->
            val expected = if (stored.composedAt > incoming.composedAt) stored else incoming
            assertEquals(expected, mergeNote(stored, incoming))
        }
    }

    @Test
    fun `applying the same write twice changes nothing the second time`() = runTest {
        checkAll(anyNote, anyNote) { stored, incoming ->
            val once = acceptWrite(stored, incoming, SERVER_NOW)
            assertEquals(once, acceptWrite(once, incoming, SERVER_NOW))
        }
    }

    @Test
    fun `only a stamp past the skew tolerance is clamped, and it becomes the server's clock`() =
        runTest {
            checkAll(anyStamp) { stamp ->
                val expected =
                    if (stamp > SERVER_NOW + MAX_COMPOSE_SKEW_AHEAD_MS) SERVER_NOW else stamp
                assertEquals(expected, clampComposedAt(stamp, SERVER_NOW))
            }
        }

    @Test
    fun `the first write of a note is stored as stated`() {
        val note = Note("n", "hello", SERVER_NOW)
        assertEquals(note, acceptWrite(null, note, SERVER_NOW))
    }
}
