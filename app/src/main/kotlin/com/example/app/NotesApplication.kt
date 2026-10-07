/*
  The Android application object: builds the app's graph once, when the process starts.
  In the app: named in AndroidManifest.xml, so Android constructs it before any screen.
  Used by: the manifest; MainActivityTest (reads the graph).
  Uses: AppGraph.
*/
package com.example.app

import android.app.Application

class NotesApplication : Application() {
    val graph: AppGraph by lazy { AppGraph() }
}
