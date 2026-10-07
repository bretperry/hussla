/*
  The domain layer: pure types, rules, and knobs, on the Kotlin standard library alone.
  In the app: every other module depends on it; it depends on none (build.gradle.kts → LAYERS).
  Used by: :usecases, :data.
*/

dependencies {
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotest.property)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(kotlin("test"))
    testRuntimeOnly(libs.junit.platform.launcher)
}
