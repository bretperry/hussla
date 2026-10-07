/*
  The Kotlin pack's Gradle build: its modules (one per layer) and where dependencies come from.
  In the app: read first by every `./gradlew` run; `pnpm kotlin:check` and the edit hook run through it.
  Used by: gradlew, stacks/kotlin/run.mjs, stacks/kotlin/check-edited.mjs, stacks/kotlin/gates.mjs.
  Uses: gradle/libs.versions.toml (versions), build.gradle.kts (the layer map that checks these modules).

  A module is a layer, so the compiler is the first boundary gate: code can only import a module
  its build file depends on. A new module needs a row in build.gradle.kts → LAYERS too, or every
  build fails.
*/

pluginManagement {
    repositories {
        // Google's Maven holds the Android Gradle Plugin; only Android's groups are read from it.
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    // Repositories are declared here only; a module that adds its own fails the build.
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        // Android's own libraries (androidx, the build tools AGP resolves) live only on Google's
        // Maven; every other group comes from Maven Central, so nothing else can be served from it.
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "app"

include(":domain", ":usecases", ":data", ":app")
