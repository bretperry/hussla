/*
  The adapter layer: one vendor or device per adapter, each implementing a :usecases port.
  In the app: only a composition root constructs these (docs/ports-and-adapters.md).
  Used by: a composition root (an Android or server module a project adds).
  Uses: :domain, :usecases (the ports).
*/

dependencies {
    implementation(project(":domain"))
    implementation(project(":usecases"))
}
