/*
  The app's one screen: says the app is ready. A project replaces it with its own UI.
  In the app: the launcher activity (AndroidManifest.xml).
  Used by: Android; MainActivityTest launches it on a device.
  Uses: strings.xml (status_ready), the R ids below.

  A plain Activity and a TextView, so the seed takes no androidx library: what a project picks for
  UI (Compose, views) is its own decision, and every library it adds is one more thing to keep current.
*/
package com.example.app

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val status = TextView(this)
        status.id = R.id.status
        status.setText(R.string.status_ready)
        setContentView(status)
    }
}
