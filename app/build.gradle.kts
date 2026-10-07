/*
  The Android app: the composition root, the one module that constructs adapters and wires them into use-cases.
  In the app: the APK. `./gradlew check` builds it, runs Android lint and its host tests; instrumented tests are `pnpm kotlin:device`.
  Used by: nothing (no module may depend on the composition root: build.gradle.kts → LAYERS).
  Uses: :domain, :usecases, :data; the Android SDK (ANDROID_HOME or local.properties sdk.dir).

  Kotlin, detekt, ktfmt, lint, and the layer gates are set up for every Android module in the root
  build.gradle.kts; this file holds what is the app's own: its ids, SDK levels, and dependencies.
*/

android {
    namespace = "com.example.app"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.example.app"
        minSdk = libs.versions.android.minSdk.get().toInt()
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
}

dependencies {
    implementation(project(":domain"))
    implementation(project(":usecases"))
    implementation(project(":data"))

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    // The JUnit 6 flavour by name: the JVM plugin infers it from useJUnitPlatform, AGP does not.
    testImplementation(kotlin("test-junit5"))
    testRuntimeOnly(libs.junit.platform.launcher)

    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
}
