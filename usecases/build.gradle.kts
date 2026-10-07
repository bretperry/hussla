/*
  The use-case layer: use-cases and the ports they declare, plus test fixtures (fakes of the ports).
  In the app: a composition root wires :data adapters into these use-cases.
  Used by: :data (implements the ports); its own tests.
  Uses: :domain, kotlinx-coroutines (timeouts, delays; virtual time in tests).

  The fakes are test fixtures (`src/testFixtures`), not production code: another module's tests
  can use them with `testImplementation(testFixtures(project(":usecases")))`.
*/

plugins { `java-test-fixtures` }

dependencies {
    implementation(project(":domain"))
    implementation(libs.kotlinx.coroutines.core)

    testFixturesImplementation(project(":domain"))
    testFixturesImplementation(libs.kotlinx.coroutines.core)

    testImplementation(project(":domain"))
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotest.property)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(kotlin("test"))
    testRuntimeOnly(libs.junit.platform.launcher)
}
