/*
  Outcome's laws, as properties: map and andThen transform a success and pass a failure through.
  In the app: nothing at runtime; runs in `./gradlew check` (pnpm kotlin:check).
  Used by: JUnit 6 (Gradle's test task).
  Uses: kotest-property (the worked example of a property test; testing-kotlin.mdc).
*/
package com.example.domain

import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.string
import io.kotest.property.checkAll
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest

class OutcomeTest {
    @Test
    fun `map transforms a success`() = runTest {
        checkAll(Arb.int()) { value ->
            assertEquals(Outcome.Ok(value.toLong() * 2), Outcome.Ok(value).map { it.toLong() * 2 })
        }
    }

    @Test
    fun `map and andThen pass a failure through untouched`() = runTest {
        checkAll(Arb.string()) { error ->
            val failed: Outcome<Int, String> = Outcome.Err(error)
            assertEquals(failed, failed.map { it + 1 })
            assertEquals(failed, failed.andThen { Outcome.Ok(it + 1) })
        }
    }

    @Test
    fun `andThen short-circuits on the first failure`() = runTest {
        checkAll(Arb.int(), Arb.string()) { value, error ->
            val chained =
                Outcome.Ok(value)
                    .andThen<Int, Int, String> { Outcome.Err(error) }
                    .andThen { Outcome.Ok(it + 1) }
            assertEquals(Outcome.Err(error), chained)
        }
    }

    @Test
    fun `getOrElse returns the value, or the fallback on a failure`() = runTest {
        checkAll(Arb.int(), Arb.int()) { value, fallback ->
            assertEquals(value, Outcome.Ok(value).getOrElse(fallback))
            assertEquals(fallback, Outcome.Err("no").getOrElse(fallback))
        }
    }
}
