/*
  The app on a real Android runtime: it starts, builds its graph, and shows its screen.
  In the app: nothing at runtime; `pnpm kotlin:device` (connectedDebugAndroidTest) on an emulator or device, and CI's Android emulator job.
  Used by: AndroidJUnitRunner (JUnit 4: the runner on the device has no JUnit 6).
  Uses: androidx.test (ActivityScenario, the JUnit 4 runner), MainActivity, NotesApplication.
*/
package com.example.app

import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.example.data.SystemWallClock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @Test
    fun the_application_wires_the_real_adapters() {
        val application = ApplicationProvider.getApplicationContext<NotesApplication>()
        assertTrue(application.graph.clock is SystemWallClock)
    }

    @Test
    fun the_screen_says_ready() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val status = activity.findViewById<TextView>(R.id.status)
                assertEquals(activity.getString(R.string.status_ready), status.text.toString())
            }
        }
    }
}
