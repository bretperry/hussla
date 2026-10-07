/*
  The composition root's wiring, on the host JVM: the graph hands use-cases the real adapters.
  In the app: nothing at runtime; runs in `./gradlew check` (pnpm kotlin:check), no emulator.
  Used by: JUnit 6 (the debug variant's unit-test task, testDebugUnitTest).
  Uses: AppGraph, data SystemWallClock.
*/
package com.example.app

import com.example.data.SystemWallClock
import kotlin.test.Test
import kotlin.test.assertIs

class AppGraphTest {
    @Test
    fun `the graph wires the system wall clock by default`() {
        assertIs<SystemWallClock>(AppGraph().clock)
    }
}
