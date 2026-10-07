/*
  The Kotlin pack's shared build: compiler, lint, format, and test settings for every module, and the layer gates.
  In the app: every ./gradlew run; `./gradlew check` is `pnpm kotlin:check` (pnpm check, CI).
  Used by: gradlew; stacks/kotlin/gates.mjs plants violations against it on a scratch copy (and reads `printLayers`).
  Uses: gradle/libs.versions.toml, config/detekt/detekt.yml; docs/ports-and-adapters.md (the layers).

  Layers are modules (domain → usecases → data, and app, the Android composition root, on top). A
  row's `android` flag says which plugin its module gets: the Android application plugin for the
  app, plain Kotlin/JVM for the rest, so the logic layers never see an Android API and stay
  host-testable. The compiler refuses an import from a module that
  isn't a dependency, and Gradle refuses a cycle, but neither says "domain takes no libraries" or
  "domain may not depend on data", and neither sees the JDK. LAYERS does, six ways:
  - after every build file is read, each module's declared production dependencies (every
    configuration feeding its compile and runtime classpaths) are checked against its row, along
    with its source directories, any detekt baseline (a file, or one set on detekt's extension
    or a task), and any setting that lets a failing gate pass (`ignoreFailures` on a test or
    detekt task or detekt's extension, detekt's `failOnSeverity` Never); a violation fails the
    build before a task runs;
  - `checkLayerResolution` (in `check`) walks every component the classpaths actually resolve to,
    which catches a dependency added during resolution, by a metadata rule, or by substitution,
    refuses a file on a classpath outside an adapter row, and refuses a compile task whose
    classpath isn't its compileClasspath;
  - `checkBytecode` (in `check`) scans each module's compiled classes (Kotlin and Java) for JDK and
    stdlib APIs: the pure layer may reference only what its row allows, the others nothing their
    row forbids, so a fully qualified name, a typealias, or Java can't dodge an import rule;
  - `checkJavaSources` (in `check`) refuses Java in a module whose bytecode is checked, unless its
    row allows Java;
  - `checkSuppressions` (in `check`) refuses `@Suppress("all")`, `@Suppress("warnings")`, a name
    that isn't a plain literal, an alias of `Suppress`, and a suppression with no `//` reason;
  - `checkTestsRan` (in `check`) fails a module whose row requires tests when it ran none.
  A row that names no module, or a module with no row, fails too, so a stale map is loud. An Android
  module adds Android lint to `check` (warnings are errors), and the settings that would quiet it
  (a baseline, abortOnError or warningsAsErrors off, a lint.xml, a check turned off outside
  LINT_DISABLED) fail the build like detekt's do.

  Keep every top-level statement above the classes at the end of this file. Kotlin block comments
  nest, so a comment opener (slash, star) written inside a comment swallows everything after it,
  and Gradle skips that silently; only a class the file still references turns it into a compile
  error. So never type that pair inside a comment, even quoted.
*/
import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.dsl.CommonExtension
import dev.detekt.gradle.Detekt
import dev.detekt.gradle.extensions.DetektExtension
import dev.detekt.gradle.extensions.FailOnSeverity
import org.gradle.api.artifacts.component.ComponentIdentifier
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.component.ProjectComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedComponentResult
import org.gradle.api.artifacts.result.ResolvedDependencyResult
import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    // `check` on the root, so `./gradlew check` also runs the root ktfmt check below.
    base
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.detekt) apply false
    alias(libs.plugins.android.application) apply false
    // Also on the root, so this file and settings.gradle.kts are formatted and checked too.
    alias(libs.plugins.ktfmt)
}

ktfmt { kotlinLangStyle() }

/*
  One layer's row.
  - mayUse: the modules its production code may depend on.
  - libraries: the libraries (group:name) it may use; ANY_LIBRARY allows all.
  - bytecodeAllowed: when not empty, the only JDK and stdlib APIs its compiled classes may
    reference (an allowlist, so an API nobody thought to forbid is refused too). Only for a row with
    no mayUse and no libraries: anything not compiled in the module itself must be on the list.
  - bytecode: JDK and stdlib references its compiled classes may not contain, checked after the
    allowlist (so a row can allow a class and forbid one member of it).
  - allowsJava: Java sources may sit in a module whose bytecode is checked; off, they fail `check`.
  - requiresTests: `check` fails when this module's test task ran no tests (skipped ones don't
    count). The gates refuse a row other than an adapter row (ANY_LIBRARY) without it, unless
    noTestsReason says why (kotlin.mdc → Every gate is proved).
  - android: the module is an Android app (the Android Gradle Plugin, not Kotlin/JVM). Only the
    composition root: such a row must allow ANY_LIBRARY and carry no bytecode rules, so a logic
    layer can't become an Android module and lose its host-only tests. (A module applying an Android
    plugin on top of the Kotlin/JVM one this build gives it fails on its own: both add `kotlin`.)
  Rule syntax: `java/io/` (ends in /) is a package and everything under it; a package followed by
  `*` (`kotlin/` then `*`) is the classes directly in it, and followed by `**` every class under
  it; `java/lang/Thread` is that class (and its nested ones); `java/lang/System.getenv` is one
  member and `java/lang/Class.getMethod*` every member starting so; `java/time/` + `*.now` is that
  member on any class in the package, `kotlin/` + `**.random*` on any class under it, and a bare
  `*.name` that member on any class at all (a call is compiled against the receiver's own type, so
  a subclass would dodge a rule naming the superclass). A member rule names a member, not an
  overload: the scan can't tell `format(String, …)` from `format(Locale, String, …)`. On an
  allowlist, a member entry (`java/lang/Class.getName`) allows that member and the class as a
  type, nothing more.
*/
data class Layer(
    val mayUse: Set<String>,
    val libraries: Set<String>,
    val bytecodeAllowed: List<String> = emptyList(),
    val bytecode: List<String> = emptyList(),
    val allowsJava: Boolean = false,
    val requiresTests: Boolean = false,
    val noTestsReason: String = "",
    val android: Boolean = false,
)

// A `libraries` entry that allows every library (adapters exist to wrap vendors).
val ANY_LIBRARY = "*"

/*
  Everything pure code may reference outside its own module: the language and the JDK's value
  types and collections. No I/O, threads, processes, the environment, logging, reflection, the
  clock, or randomness, and no package of the JDK or the stdlib that isn't named here. Widening it
  is a decision (docs/decisions/); stacks/kotlin/gates.mjs plants one sample of each refused family.
*/
val PURE_BYTECODE_ALLOWED =
    listOf(
        // The Kotlin standard library's pure packages. Not kotlin/io, kotlin/system, kotlin/random,
        // kotlin/concurrent, kotlin/uuid, or the rest of kotlin/time and kotlin/jvm.
        "kotlin/*",
        "kotlin/annotation/",
        "kotlin/collections/",
        "kotlin/comparisons/",
        "kotlin/contracts/",
        "kotlin/coroutines/",
        "kotlin/enums/",
        "kotlin/experimental/",
        "kotlin/internal/",
        "kotlin/jvm/functions/",
        "kotlin/jvm/internal/",
        "kotlin/math/",
        "kotlin/properties/",
        "kotlin/ranges/",
        "kotlin/reflect/",
        "kotlin/sequences/",
        "kotlin/text/",
        "kotlin/jvm/JvmField",
        "kotlin/jvm/JvmInline",
        "kotlin/jvm/JvmName",
        "kotlin/jvm/JvmOverloads",
        "kotlin/jvm/JvmStatic",
        "kotlin/jvm/Throws",
        "kotlin/time/Duration",
        "kotlin/time/DurationKt",
        "kotlin/time/DurationUnit",
        // A point in time as a value (its deprecated `now` is a compile error; the clocks stay
        // out).
        "kotlin/time/Instant",
        // Base64 and other byte encodings (their stream wrappers need java.io, which stays out).
        "kotlin/io/encoding/",
        // The stdlib's nullability annotations.
        "org/jetbrains/annotations/",
        // java.lang value types, exceptions, and what the compiler emits for lambdas and string
        // templates. Class only as a type and by name: its other members are reflection.
        "java/lang/Object",
        "java/lang/String",
        "java/lang/CharSequence",
        "java/lang/StringBuilder",
        "java/lang/Number",
        "java/lang/Boolean",
        "java/lang/Byte",
        "java/lang/Short",
        "java/lang/Integer",
        "java/lang/Long",
        "java/lang/Float",
        "java/lang/Double",
        "java/lang/Character",
        "java/lang/Void",
        "java/lang/Math",
        "java/lang/StrictMath",
        "java/lang/Enum",
        "java/lang/Record",
        "java/lang/Comparable",
        "java/lang/Iterable",
        "java/lang/Cloneable",
        "java/lang/AutoCloseable",
        "java/lang/Deprecated",
        "java/lang/Override",
        "java/lang/FunctionalInterface",
        "java/lang/SafeVarargs",
        "java/lang/Throwable",
        "java/lang/Exception",
        "java/lang/RuntimeException",
        "java/lang/Error",
        "java/lang/AssertionError",
        "java/lang/ArithmeticException",
        "java/lang/ClassCastException",
        "java/lang/IllegalArgumentException",
        "java/lang/IllegalStateException",
        "java/lang/IndexOutOfBoundsException",
        "java/lang/ArrayIndexOutOfBoundsException",
        "java/lang/NullPointerException",
        "java/lang/NumberFormatException",
        "java/lang/UnsupportedOperationException",
        // What a `when` over an enum compiles to (`$WhenMappings` catches it).
        "java/lang/NoSuchFieldError",
        "java/lang/Class.getName",
        "java/lang/Class.getSimpleName",
        "java/lang/Class.isInstance",
        "java/lang/Class.cast",
        "java/lang/Class.desiredAssertionStatus",
        "java/lang/annotation/",
        "java/lang/invoke/LambdaMetafactory",
        "java/lang/invoke/StringConcatFactory",
        "java/lang/invoke/CallSite",
        "java/lang/invoke/MethodType",
        "java/lang/invoke/MethodHandle",
        "java/lang/invoke/MethodHandles\$Lookup.lookupClass",
        // java.util collections and value types.
        "java/util/AbstractCollection",
        "java/util/AbstractList",
        "java/util/AbstractMap",
        "java/util/AbstractSet",
        "java/util/ArrayList",
        "java/util/Arrays",
        "java/util/Collection",
        "java/util/Collections",
        "java/util/Comparator",
        "java/util/HashMap",
        "java/util/HashSet",
        "java/util/Iterator",
        "java/util/LinkedHashMap",
        "java/util/LinkedHashSet",
        "java/util/List",
        "java/util/ListIterator",
        "java/util/Map",
        "java/util/NoSuchElementException",
        "java/util/Objects",
        "java/util/RandomAccess",
        "java/util/Set",
        "java/util/SortedMap",
        "java/util/SortedSet",
        "java/util/NavigableMap",
        "java/util/NavigableSet",
        "java/util/TreeMap",
        "java/util/TreeSet",
        "java/util/UUID",
        "java/util/Locale.ROOT",
        "java/util/regex/",
        // Numbers, dates, and charsets as values; the members that read the clock, the default
        // zone,
        // locale, or charset, or make a random id, are denied below.
        "java/math/",
        "java/time/",
        "java/nio/charset/Charset",
    )

/*
  Members of allowed classes pure code still may not call: randomness, the clock, the default zone,
  locale, and charset, the environment (a system property read by a number's name), and stderr
  (printStackTrace, on any exception class). `String.format` stays refused although
  `format(Locale.ROOT, …)` is pure: the scan sees member names, not overloads, and the one-argument
  form reads the default locale; use a string template.
*/
val PURE_FORBIDDEN_BYTECODE =
    listOf(
        "java/lang/Math.random",
        "java/lang/StrictMath.random",
        "java/lang/String.format",
        "java/lang/Integer.getInteger",
        "java/lang/Long.getLong",
        "java/lang/Boolean.getBoolean",
        "*.printStackTrace",
        "java/util/Collections.shuffle",
        "java/util/UUID.randomUUID",
        "kotlin/**.random*",
        "kotlin/**.shuffle*",
        "java/time/*.now",
        "java/time/chrono/*.dateNow",
        "java/time/Clock",
        "java/time/InstantSource",
        "java/time/*.systemDefault",
        "java/time/format/DateTimeFormatter.ofPattern",
        "java/time/format/DateTimeFormatter.ofLocalized*",
        "java/nio/charset/Charset.defaultCharset",
    )

/*
  What a use-case may not touch: I/O, processes (and exiting or loading native code), threads and
  thread pools, timers, logging, and preferences go through a port, implemented by an adapter in
  :data. Reflection, service loading, JNDI, RMI, and the jdk.* modules are refused too: a class
  loaded by name is a dependency the layer map can't see. Coroutines (kotlinx) stay allowed; they
  are how a use-case waits. kotlin.system has no rule: every function in it is inline, so its
  bytecode is java.lang.System's (`exitProcess` is `System.exit`). A denylist, not an allowlist
  (docs/deferred.md → Kotlin pack).
*/
val USECASE_FORBIDDEN_BYTECODE =
    listOf(
        "java/io/",
        "java/net/",
        "java/sql/",
        "java/nio/file/",
        "java/nio/channels/",
        "kotlin/io/path/",
        "kotlin/io/ConsoleKt",
        "java/lang/ProcessBuilder",
        "java/lang/Runtime",
        "java/lang/ProcessHandle",
        "java/lang/System.exit",
        "java/lang/System.load*",
        "java/lang/Thread",
        "kotlin/concurrent/",
        "java/util/concurrent/Executors",
        "java/util/concurrent/ThreadPoolExecutor",
        "java/util/concurrent/ScheduledThreadPoolExecutor",
        "java/util/concurrent/ForkJoinPool",
        "java/util/Timer",
        "java/util/zip/",
        "java/util/ServiceLoader",
        "java/beans/",
        "javax/naming/",
        "java/rmi/",
        "jdk/",
        "java/util/prefs/",
        "java/util/logging/",
        "java/lang/System.getLogger",
        "java/lang/reflect/",
        "java/lang/ClassLoader",
        "java/lang/Class.forName",
        "java/lang/Class.getMethod*",
        "java/lang/Class.getConstructor*",
        "java/lang/Class.getDeclared*",
        "java/lang/Class.getField*",
        "java/lang/Class.getResource*",
        "java/lang/invoke/MethodHandles.*",
    )

// Knob: the layer map. Who may depend on whom (docs/ports-and-adapters.md). Tests and test fixtures
// are exempt. Widening a row is a decision, not a fix: record it in docs/decisions/.
val LAYERS =
    mapOf(
        // Pure domain types, rules, and knobs: the Kotlin standard library and nothing else.
        ":domain" to
            Layer(
                mayUse = emptySet(),
                libraries = emptySet(),
                bytecodeAllowed = PURE_BYTECODE_ALLOWED,
                bytecode = PURE_FORBIDDEN_BYTECODE,
                requiresTests = true,
            ),
        // Use-cases and the ports they declare.
        ":usecases" to
            Layer(
                mayUse = setOf(":domain"),
                libraries = setOf("org.jetbrains.kotlinx:kotlinx-coroutines-core"),
                bytecode = USECASE_FORBIDDEN_BYTECODE,
                requiresTests = true,
            ),
        // Adapters: one vendor or device each, implementing a port. Any library.
        ":data" to Layer(mayUse = setOf(":domain", ":usecases"), libraries = setOf(ANY_LIBRARY)),
        // The Android app: the composition root, which constructs adapters and wires them into
        // use-cases. It may use every layer and any library; nothing may use it.
        ":app" to
            Layer(
                mayUse = setOf(":domain", ":usecases", ":data"),
                libraries = setOf(ANY_LIBRARY),
                requiresTests = true,
                android = true,
            ),
    )

// The resolvable classpaths production code compiles and runs against; test ones are exempt.
val PRODUCTION_CLASSPATHS = listOf("compileClasspath", "runtimeClasspath")

// An Android module's: one pair per build type (AGP names them by variant).
val ANDROID_PRODUCTION_CLASSPATHS =
    listOf(
        "debugCompileClasspath",
        "debugRuntimeClasspath",
        "releaseCompileClasspath",
        "releaseRuntimeClasspath",
    )

// detekt's type-resolving tasks, one per source set (detektMain, detektTest, detektTestFixtures).
val DETEKT_TYPED_TASK = Regex("detekt(Main|Test|TestFixtures)")

// On an Android module they are one per variant (detektDebug, detektRelease, detektDebugUnitTest,
// detektDebugAndroidTest); its per-source-set ones (detektMain) run without type resolution.
val DETEKT_ANDROID_TYPED_TASK = Regex("detekt(Debug|Release)(UnitTest|AndroidTest)?")

// Android source sets that hold tests (test, testDebug, androidTest, testFixtures, …); every
// other set (main, debug, release, a flavor) ships in the app, so checkSuppressions reads it.
val TEST_SOURCE_SET_PREFIXES = listOf("test", "androidTest")

// The host test task an Android module's `test` runs (AGP builds unit tests for debug only).
val ANDROID_UNIT_TEST_TASK = "testDebugUnitTest"

/*
  Knob: Android lint checks that stay off, each with why. Every other check is on, and a warning is
  an error. A module turning one more off (disable, ignore, informational, checkOnly, a lint.xml)
  fails the build: fix the finding, or @SuppressLint the one declaration with a // reason.
  - GradleDependency, AndroidGradlePluginVersion, NewerVersionAvailable, OldTargetApi: they compare
    against whatever Google released this week, so a new release would turn a green build red with
    no change here. Versions move on purpose, in gradle/libs.versions.toml.
*/
val LINT_DISABLED =
    setOf("GradleDependency", "AndroidGradlePluginVersion", "NewerVersionAvailable", "OldTargetApi")

// A lint configuration file, which can turn any check off or down to a warning; lint reads one from
// the module and every directory above it.
val LINT_CONFIG = "lint.xml"

// The Kotlin plugin adds its standard library to every module; it is part of the language.
val ALWAYS_ALLOWED = setOf("org.jetbrains.kotlin:kotlin-stdlib")

/*
  Knob: what each allowed library brings with it, by group:name. checkLayerResolution walks every
  component a production classpath resolves to and allows only the row's libraries, the stdlib, and
  these. A library's own dependency list can't be trusted instead: a component metadata rule can add
  anything to it. A version bump that adds a dependency fails here, naming it: add it.
*/
val LIBRARY_DEPENDENCIES =
    mapOf(
        "org.jetbrains.kotlin:kotlin-stdlib" to setOf("org.jetbrains:annotations"),
        "org.jetbrains.kotlinx:kotlinx-coroutines-core" to
            setOf(
                "org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm",
                "org.jetbrains.kotlinx:kotlinx-coroutines-bom",
                "org.jetbrains:annotations",
            ),
    )

// A detekt baseline silences every finding it lists; this build never reads one.
val DETEKT_BASELINE = Regex("detekt-baseline.*\\.xml")

// Directories a scan of a project's own files skips: build output and caches.
val GENERATED_DIRS = setOf("build", ".gradle", ".kotlin")

// The fix every boundary message ends with.
val PORT_FIX =
    "put the code it needs behind a port in :usecases and wire the adapter in the composition root (docs/ports-and-adapters.md)"

subprojects {
    // This module's path, named outside the task blocks (inside one, `path` is the task's).
    val module = path
    val layer = LAYERS[module]
    // Its row says what kind of module it is: the Android app, or plain Kotlin/JVM.
    val isAndroid = layer?.android == true

    apply(plugin = if (isAndroid) "com.android.application" else "org.jetbrains.kotlin.jvm")
    apply(plugin = "dev.detekt")
    apply(plugin = "com.ncorti.ktfmt.gradle")

    if (isAndroid) {
        // AGP's built-in Kotlin compiles the module; the same toolchain and warnings rule as the
        // rest.
        extensions.configure<KotlinAndroidProjectExtension> {
            jvmToolchain(21)
            compilerOptions { allWarningsAsErrors = true }
        }
        extensions.configure<ApplicationExtension> {
            compileOptions {
                sourceCompatibility = JavaVersion.VERSION_21
                targetCompatibility = JavaVersion.VERSION_21
            }
            // Android lint runs in `check` (on the default variant); a warning is an error, like a
            // detekt finding. failureSwitchProblems refuses a module that quiets it again.
            lint {
                abortOnError = true
                warningsAsErrors = true
                disable += LINT_DISABLED
            }
        }
    } else {
        extensions.configure<KotlinJvmProjectExtension> {
            jvmToolchain(21)
            // A compiler warning is a finding like any other (a deprecated call, an unchecked
            // cast).
            compilerOptions { allWarningsAsErrors = true }
        }
    }

    extensions.configure<DetektExtension> {
        // detekt's defaults plus the overrides in detekt.yml; any finding fails the build.
        buildUponDefaultConfig = true
        config.setFrom(rootProject.file("config/detekt/detekt.yml"))
    }

    extensions.configure<com.ncorti.ktfmt.gradle.KtfmtExtension> { kotlinLangStyle() }

    // `check` runs detekt with type resolution, per source set (per variant on Android: more rules,
    // such as unsafe casts, swallowed cancellation, forbidden calls); the plain `detekt` task would
    // report the same files again.
    val detektTyped = if (isAndroid) DETEKT_ANDROID_TYPED_TASK else DETEKT_TYPED_TASK
    tasks.named("check") {
        dependsOn(tasks.withType<Detekt>().matching { it.name.matches(detektTyped) })
    }
    tasks.named("detekt") { enabled = false }
    // A baseline silences the findings it lists while the build stays green; fix or @Suppress
    // instead.
    tasks.matching { it.name.startsWith("detektBaseline") }.configureEach { enabled = false }

    tasks.withType<Test>().configureEach { useJUnitPlatform() }

    val mainKotlin = provider { mainSourceDirectories(project) }
    // A JVM module's main source set (Android has none: AGP builds variants instead).
    val jvmMain = if (isAndroid) null else the<SourceSetContainer>().getByName("main")
    val classpaths = productionClasspaths(isAndroid)

    val checkLayerResolution =
        tasks.register<LayerResolutionCheck>("checkLayerResolution") {
            description = "Checks this module's resolved production dependencies against LAYERS."
            modulePath = module
            mayUse = layer?.mayUse ?: emptySet()
            val rowLibraries = layer?.libraries ?: emptySet()
            libraries = rowLibraries
            // The stdlib, the row's libraries, and what each brings with it (LIBRARY_DEPENDENCIES).
            alwaysAllowed =
                (ALWAYS_ALLOWED + rowLibraries).flatMap {
                    setOf(it) + LIBRARY_DEPENDENCIES[it].orEmpty()
                }
            for (classpath in classpaths) {
                roots.put(
                    classpath,
                    configurations.named(classpath).flatMap {
                        it.incoming.resolutionResult.rootComponent
                    },
                )
            }
            // Files on a classpath that come from neither a module nor a project (a files()
            // dependency added during resolution), as "name (classpath)". An adapter row may use
            // any library, so it may use a file too.
            if (ANY_LIBRARY !in rowLibraries) {
                for (classpath in classpaths) {
                    fileArtifacts.addAll(
                        configurations.named(classpath).flatMap { configuration ->
                            configuration.incoming
                                .artifactView {
                                    componentFilter {
                                        it !is ModuleComponentIdentifier &&
                                            it !is ProjectComponentIdentifier
                                    }
                                }
                                .artifacts
                                .resolvedArtifacts
                                .map { artifacts ->
                                    artifacts.map { "${it.file.name} ($classpath)" }
                                }
                        }
                    )
                }
            }
            // What the compilers really read, against the classpath LAYERS checks. Paths only
            // (Internal), so this task doesn't wait on a compile. Not on Android: AGP compiles
            // against android.jar and generated R classes on top of the classpath, and an Android
            // row allows every library anyway (layerProblems), so there is nothing to refuse.
            if (jvmMain != null) {
                declaredClasspath.from(configurations.named("compileClasspath"))
                kotlinLibraries.from(
                    tasks.named<KotlinCompile>("compileKotlin").map { it.libraries }
                )
                javaClasspath.from(tasks.named<JavaCompile>("compileJava").map { it.classpath })
                ownClasses.from(jvmMain.output.classesDirs)
            }
        }

    val checkSuppressions =
        tasks.register<SuppressionCheck>("checkSuppressions") {
            description =
                "Refuses @Suppress(\"all\"), @Suppress(\"warnings\"), @SuppressLint(\"all\"), //noinspection ALL, tools:ignore=\"all\", a non-literal name, an alias of Suppress, and a suppression with no // reason in production code."
            sources.from(mainKotlin)
            // Every production source set of an Android module (main, debug, release, flavors):
            // its code, resources, and manifest, where tools:ignore can quiet lint too.
            if (isAndroid) sources.from(provider { androidProductionSources(project) })
            rootDirectory = rootDir
        }

    tasks.named("check") { dependsOn(checkLayerResolution, checkSuppressions) }

    if (
        jvmMain != null &&
            layer != null &&
            (layer.bytecodeAllowed.isNotEmpty() || layer.bytecode.isNotEmpty())
    ) {
        val main = jvmMain
        val checkBytecode =
            tasks.register<BytecodeCheck>("checkBytecode") {
                description = "Scans this module's compiled classes for the APIs LAYERS forbids it."
                modulePath = module
                allowed = layer.bytecodeAllowed
                forbidden = layer.bytecode
                // Every compiler's output (Kotlin and Java), which also makes this run after them.
                classes.from(main.output.classesDirs)
            }
        tasks.named("check") { dependsOn(checkBytecode) }
        if (!layer.allowsJava) {
            val checkJavaSources =
                tasks.register<JavaSourceCheck>("checkJavaSources") {
                    description =
                        "Refuses Java sources in a module whose LAYERS row doesn't allow Java."
                    modulePath = module
                    javaSources.from(
                        files(mainKotlin, main.java.srcDirs).asFileTree.matching {
                            include("**/*.java")
                        }
                    )
                    rootDirectory = rootDir
                }
            tasks.named("check") { dependsOn(checkJavaSources) }
        }
    }

    if (layer?.requiresTests == true) {
        // The tests the run executed, counted by a listener: the XML report counts an empty
        // @TestFactory as a test. An output of the test task, so a cached run restores it too.
        // AGP registers its test task after this block runs, so it is found by name, lazily.
        val testTask = if (isAndroid) ANDROID_UNIT_TEST_TASK else "test"
        val ranCount = layout.buildDirectory.file("test-results/test-ran.txt")
        tasks
            .withType<Test>()
            .matching { it.name == testTask }
            .configureEach {
                outputs.file(ranCount)
                addTestListener(RanTestsRecorder(ranCount.get().asFile))
            }
        val checkTestsRan =
            tasks.register<TestsRanCheck>("checkTestsRan") {
                description = "Fails when this module's test task ran no tests."
                modulePath = module
                results = ranCount
                dependsOn(testTask)
            }
        tasks.named("check") { dependsOn(checkTestsRan) }
    }
}

// The resolvable classpaths a module's production code compiles and runs against.
fun productionClasspaths(isAndroid: Boolean): List<String> =
    if (isAndroid) ANDROID_PRODUCTION_CLASSPATHS else PRODUCTION_CLASSPATHS

// Whether a module is an Android one (any Android plugin adds the `android` extension).
fun isAndroidModule(module: Project): Boolean = module.extensions.findByName("android") != null

// The `android` extension every Android plugin adds (app, library, or test module).
fun androidOf(module: Project): CommonExtension =
    module.extensions.getByName("android") as CommonExtension

// A module's main source directories (Kotlin and Java), whichever plugin builds it.
fun mainSourceDirectories(module: Project): Set<File> =
    if (isAndroidModule(module))
        androidOf(module)
            .sourceSets
            .getByName("main")
            .kotlin
            .directories
            .map { module.file(it) }
            .toSet()
    else
        module.extensions
            .getByType<KotlinJvmProjectExtension>()
            .sourceSets
            .getByName("main")
            .kotlin
            .srcDirs

// An Android module's production source sets (every set but the test ones): each one's code and
// resource directories (a build file can add more) and its `src/<set>` folder, which holds the
// default resources and the manifest.
fun androidProductionSources(module: Project): Set<File> =
    androidOf(module)
        .sourceSets
        .filterNot { set -> TEST_SOURCE_SET_PREFIXES.any { set.name.startsWith(it) } }
        .flatMap { set ->
            (set.kotlin.directories + set.java.directories + set.res.directories).map {
                module.file(it)
            } + module.file("src/${set.name}")
        }
        .toSet()

// Every source set's directories, by source set name, whichever plugin builds the module.
fun allSourceDirectories(module: Project): Map<String, Set<File>> =
    if (isAndroidModule(module))
        androidOf(module).sourceSets.associate { set ->
            set.name to
                (set.kotlin.directories + set.java.directories).map { module.file(it) }.toSet()
        }
    else
        module.extensions.getByType<KotlinJvmProjectExtension>().sourceSets.associate {
            it.name to it.kotlin.srcDirs
        }

// A path as the build prints it: relative to the root when it is inside it.
fun shown(file: File): String = file.relativeToOrSelf(rootDir).invariantSeparatorsPath

// What a declared dependency is, for a message: a module path, group:name, or the files it adds.
fun describe(dependency: Dependency): String =
    when (dependency) {
        is ProjectDependency -> dependency.path
        is FileCollectionDependency -> "files ${dependency.files.files.joinToString { shown(it) }}"
        else -> "${dependency.group}:${dependency.name}"
    }

// Each violation of LAYERS a build file can show before any task runs, as a line ending in its fix.
fun layerProblems(): List<String> {
    val modules = subprojects.associateBy { it.path }
    val problems = mutableListOf<String>()
    for (path in modules.keys - LAYERS.keys) {
        problems +=
            "module $path has no row in LAYERS (build.gradle.kts): add one, or its dependencies are unchecked."
    }
    for ((path, layer) in LAYERS) {
        if (path !in modules) {
            problems +=
                "LAYERS row $path matches no module (${modules.keys.joinToString()}): fix the spelling, or the rule checks nothing."
        }
        for (used in layer.mayUse - modules.keys) {
            problems += "LAYERS row $path: mayUse $used matches no module: fix the spelling."
        }
        if (
            layer.bytecodeAllowed.isNotEmpty() &&
                (layer.mayUse.isNotEmpty() || layer.libraries.isNotEmpty())
        ) {
            problems +=
                "LAYERS row $path has a bytecode allowlist and modules or libraries to use: an allowlist is for the pure layer, which uses neither (anything outside the module must be on the list)."
        }
        if (
            layer.android &&
                (ANY_LIBRARY !in layer.libraries ||
                    layer.bytecode.isNotEmpty() ||
                    layer.bytecodeAllowed.isNotEmpty())
        ) {
            problems +=
                "LAYERS row $path is an Android module, which only the composition root may be: it allows ANY_LIBRARY and carries no bytecode rules (they aren't checked on Android). Keep rules-bound code in a JVM layer."
        }
    }
    for ((path, module) in modules) {
        val layer = LAYERS[path]
        problems += sourceDirectoryProblems(path, module)
        problems += baselineProblems(module.projectDir)
        problems += baselineSettingProblems(path, module)
        problems += failureSwitchProblems(path, module)
        problems += lintProblems(path, module)
        problems += lintConfigProblems(module.projectDir)
        if (layer == null) continue
        problems += declaredDependencyProblems(path, module, layer)
    }
    problems += baselineProblems(rootDir, recursive = false)
    problems += baselineProblems(rootDir.resolve("config/detekt"))
    problems += lintConfigProblems(rootDir, recursive = false)
    return problems.distinct()
}

// Every source directory must sit inside its own module, or one module compiles another's code.
fun sourceDirectoryProblems(path: String, module: Project): List<String> =
    allSourceDirectories(module).flatMap { (set, directories) ->
        directories
            .filterNot { it.canonicalFile.startsWith(module.projectDir.canonicalFile) }
            .map {
                "module $path: source directory ${shown(it)} (source set $set) is outside the module: move the code into this module, or depend on the module that owns it."
            }
    }

// Any detekt baseline file, which would silence the findings it lists.
fun baselineProblems(dir: File, recursive: Boolean = true): List<String> {
    if (!dir.isDirectory) return emptyList()
    val files =
        if (recursive)
            dir.walkTopDown()
                .onEnter { it == dir || it.name !in GENERATED_DIRS }
                .filter { it.isFile }
        else dir.listFiles().orEmpty().asSequence().filter { it.isFile }
    return files
        .filter { it.name.matches(DETEKT_BASELINE) }
        .map {
            "${shown(it)} is a detekt baseline, which silences findings: delete it, then fix each finding or @Suppress it with a // reason."
        }
        .toList()
}

/*
  A baseline set in a build file, under any name: on detekt's extension (its default, the
  detekt-baseline.xml the file scan above refuses, is the only value allowed) or on a task that
  runs. The tasks are realized here, after every build file has configured them.
*/
fun baselineSettingProblems(path: String, module: Project): List<String> {
    val problems = mutableListOf<String>()
    val fix = "remove it, then fix each finding or @Suppress it with a // reason."
    val extension = module.extensions.getByType<DetektExtension>().baseline.orNull?.asFile
    if (extension != null && extension != module.file("detekt-baseline.xml")) {
        problems +=
            "module $path: the detekt extension sets a baseline (${shown(extension)}), which silences findings: $fix"
    }
    for (task in module.tasks.withType<Detekt>().filter { it.enabled }) {
        val baseline = task.baseline.orNull?.asFile ?: continue
        problems +=
            "task ${task.path} sets a detekt baseline (${shown(baseline)}), which silences findings: $fix"
    }
    return problems
}

/*
  A setting that lets a gate fail while the build stays green: `ignoreFailures` on a test task, on
  a detekt task, or on detekt's extension (which every detekt task inherits), and detekt's
  `failOnSeverity` set to Never. The findings would still print, and nothing would read them.
*/
fun failureSwitchProblems(path: String, module: Project): List<String> {
    val problems = mutableListOf<String>()
    val fix =
        "remove it; a gate that can't fail the build is off (kotlin.mdc → Every gate is proved)."
    val extension = module.extensions.getByType<DetektExtension>()
    if (extension.ignoreFailures.orNull == true) {
        problems += "module $path: the detekt extension sets ignoreFailures: $fix"
    }
    if (extension.failOnSeverity.orNull == FailOnSeverity.Never) {
        problems += "module $path: the detekt extension sets failOnSeverity Never: $fix"
    }
    for (task in module.tasks.withType<Detekt>().filter { it.enabled }) {
        if (task.ignoreFailures.orNull == true) {
            problems += "task ${task.path} sets ignoreFailures: $fix"
        }
        if (task.failOnSeverity.orNull == FailOnSeverity.Never) {
            problems += "task ${task.path} sets failOnSeverity Never: $fix"
        }
    }
    for (task in module.tasks.withType<Test>().filter { it.ignoreFailures }) {
        problems += "task ${task.path} sets ignoreFailures: $fix"
    }
    return problems
}

/*
  What would quiet Android lint while the build stays green: abortOnError or warningsAsErrors off,
  ignoreWarnings, a baseline (it silences what it lists), a lint config file set on the DSL, a
  narrowed checkOnly, and a check turned off or down (disable, ignore, informational) beyond
  LINT_DISABLED. Read after every build file has run, so a module can't undo the root's settings.
*/
fun lintProblems(path: String, module: Project): List<String> {
    if (!isAndroidModule(module)) return emptyList()
    val lint = androidOf(module).lint
    val fix =
        "remove it; fix the finding, or @SuppressLint the one declaration with a // reason (kotlin.mdc → Android)."
    val problems = mutableListOf<String>()
    if (!lint.abortOnError) problems += "module $path: lint sets abortOnError false: $fix"
    if (!lint.warningsAsErrors) problems += "module $path: lint sets warningsAsErrors false: $fix"
    if (lint.ignoreWarnings) problems += "module $path: lint sets ignoreWarnings: $fix"
    lint.baseline?.let {
        problems +=
            "module $path: lint sets a baseline (${shown(it)}), which silences findings: $fix"
    }
    lint.lintConfig?.let {
        problems +=
            "module $path: lint reads a config file (${shown(it)}), which can turn checks off: $fix"
    }
    if (lint.checkOnly.isNotEmpty()) {
        problems += "module $path: lint sets checkOnly ${lint.checkOnly.sorted()}: $fix"
    }
    for ((name, ids) in
        listOf(
            "disable" to lint.disable,
            "ignore" to lint.ignore,
            "informational" to lint.informational,
        )) {
        val extra = ids - LINT_DISABLED
        if (extra.isNotEmpty()) {
            problems +=
                "module $path: lint $name ${extra.sorted()} turns a check off or down outside LINT_DISABLED (build.gradle.kts): $fix"
        }
    }
    return problems
}

// A lint.xml, which lint reads from a module and every directory above it.
fun lintConfigProblems(dir: File, recursive: Boolean = true): List<String> {
    if (!dir.isDirectory) return emptyList()
    val files =
        if (recursive)
            dir.walkTopDown()
                .onEnter { it == dir || it.name !in GENERATED_DIRS }
                .filter { it.isFile }
        else dir.listFiles().orEmpty().asSequence().filter { it.isFile }
    return files
        .filter { it.name == LINT_CONFIG }
        .map {
            "${shown(it)} is a lint config file, which can turn checks off: delete it; LINT_DISABLED in build.gradle.kts is the one list of checks that stay off."
        }
        .toList()
}

// The declared dependencies feeding a module's production classpaths, including any configuration
// that extends into them, checked against its row.
fun declaredDependencyProblems(path: String, module: Project, layer: Layer): List<String> {
    val problems = mutableListOf<String>()
    for (classpath in productionClasspaths(isAndroidModule(module))) {
        val configuration = module.configurations.findByName(classpath) ?: continue
        for (bucket in configuration.hierarchy) {
            for (dependency in bucket.dependencies) {
                val via = "declared in ${bucket.name}"
                if (
                    dependency is ModuleDependency &&
                        dependency.requestedCapabilities.any { it.name.endsWith("-test-fixtures") }
                ) {
                    problems +=
                        "module $path depends on test fixtures of ${describe(dependency)} ($via): fakes are test code; use testImplementation(testFixtures(...)) instead."
                    continue
                }
                if (dependency is ProjectDependency) {
                    if (dependency.path !in layer.mayUse) {
                        problems +=
                            "module $path depends on ${dependency.path} ($via), which its layer may not use (mayUse: ${layer.mayUse}): $PORT_FIX."
                    }
                    continue
                }
                val library = describe(dependency)
                if (
                    library in ALWAYS_ALLOWED ||
                        ANY_LIBRARY in layer.libraries ||
                        library in layer.libraries
                )
                    continue
                problems +=
                    "module $path uses library $library ($via), which its layer does not allow (libraries: ${layer.libraries}): move that code to a layer that allows it, or widen the row on purpose."
            }
        }
    }
    return problems
}

// Runs once every module's build file has been read, so the dependencies are all declared.
gradle.projectsEvaluated {
    val problems = layerProblems()
    if (problems.isNotEmpty()) {
        throw GradleException(
            "Layer boundaries (build.gradle.kts → LAYERS):\n" +
                problems.joinToString("\n") { "  - $it" }
        )
    }
}

/*
  A gate task turned off is skipped while `check` stays green, the same as deleting the gate. Two
  ways in, both refused once the task graph is known:
  - `enabled = false`: any lint, detekt, ktfmt, check, test, or compile task of a LAYERS module that
    the build is about to run and finds disabled fails it, except the two this file turns off itself
    (the untyped `detekt`, which the typed ones replace, and `detektBaseline*`; see the subprojects
    block).
  - Left out of the graph (`-x`, `excludedTaskNames`, `check`'s dependencies replaced): when a
    module's `check` runs, every gate in CHECK_GATES (and its plugin's list) that the module has
    must run with it.
  Not caught: an `onlyIf { false }`, which Gradle can't report before the task runs
  (docs/deferred.md).
*/
val GATE_TASK = Regex("(lint|detekt|ktfmtCheck|check|test|compile).*")
val TURNED_OFF_HERE = Regex("detekt|detektBaseline.*")

// The gates a module's `check` runs, whichever of them the module has.
val CHECK_GATES =
    listOf(
        "checkLayerResolution",
        "checkSuppressions",
        "checkBytecode",
        "checkJavaSources",
        "checkTestsRan",
        "ktfmtCheckMain",
        "ktfmtCheckTest",
        "test",
    )

// On top of CHECK_GATES, by plugin: detekt is per source set on the JVM and per variant on Android
// (whose per-source-set detektMain runs untyped and stays out of `check`), plus lint and the unit
// test task on Android.
val JVM_CHECK_GATES = listOf("detektMain", "detektTest")
val ANDROID_CHECK_GATES =
    listOf(
        "detektDebug",
        "detektRelease",
        "detektDebugUnitTest",
        "detektDebugAndroidTest",
        ANDROID_UNIT_TEST_TASK,
        "lintDebug",
    )

gradle.taskGraph.whenReady {
    val graph = this
    val modules = LAYERS.keys
    val disabled =
        allTasks
            .filter { it.project.path in modules && it.name.matches(GATE_TASK) && !it.enabled }
            .filterNot { it.name.matches(TURNED_OFF_HERE) }
            .map { "${it.path} is disabled: a gate task must run; fix what it reports instead." }
    val skipped =
        allTasks
            .filter { it.name == "check" && it.project.path in modules }
            .flatMap { check ->
                val extra =
                    if (isAndroidModule(check.project)) ANDROID_CHECK_GATES else JVM_CHECK_GATES
                (CHECK_GATES + extra)
                    .mapNotNull { check.project.tasks.findByName(it) }
                    .filterNot { graph.hasTask(it) }
                    .map {
                        "${it.path} doesn't run with ${check.path}: a gate can't be excluded (-x, excludedTaskNames) or unwired from check; fix what it reports instead."
                    }
            }
    val problems = disabled + skipped
    if (problems.isNotEmpty()) {
        throw GradleException("Skipped gate tasks:\n" + problems.joinToString("\n") { "  - $it" })
    }
}

// The package most of a module's main Kotlin files declare (ties go to the first in sorted order),
// so the answer doesn't depend on the order the file system lists them in.
fun mainPackage(module: Project?): String {
    val sourceRoot = module?.projectDir?.resolve("src/main/kotlin") ?: return ""
    return sourceRoot
        .walkTopDown()
        .filter { it.isFile && it.extension == "kt" }
        .mapNotNull { file ->
            file.useLines { lines -> lines.firstOrNull { it.startsWith("package ") } }
        }
        .map { it.removePrefix("package ").trim() }
        .groupingBy { it }
        .eachCount()
        .entries
        .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        .firstOrNull()
        ?.key
        .orEmpty()
}

// The layer map as one JSON line, for stacks/kotlin/gates.mjs: each row's module directory and the
// package of its main code, so the gates plant probes where the code really lives.
val layersJson = provider {
    groovy.json.JsonOutput.toJson(
        LAYERS.map { (path, layer) ->
            val module = findProject(path)
            mapOf(
                "path" to path,
                "dir" to module?.let { shown(it.projectDir) }.orEmpty(),
                "package" to mainPackage(module),
                "mayUse" to layer.mayUse.toList(),
                "libraries" to layer.libraries.toList(),
                "bytecodeAllowed" to layer.bytecodeAllowed,
                "bytecode" to layer.bytecode,
                "allowsJava" to layer.allowsJava,
                "requiresTests" to layer.requiresTests,
                "noTestsReason" to layer.noTestsReason,
                "android" to layer.android,
            )
        }
    )
}

tasks.register<PrintLayers>("printLayers") {
    description = "Prints LAYERS as JSON (for stacks/kotlin/gates.mjs)."
    json = layersJson
}

abstract class PrintLayers : DefaultTask() {
    @get:Input abstract val json: Property<String>

    @TaskAction fun print() = println("LAYERS_JSON ${json.get()}")
}

/*
  What the classpaths resolve to, which can differ from what the build files declare: a dependency
  added with withDependencies, by a component metadata rule (one library's metadata naming another),
  or by substitution only appears here. So every resolved component is checked, not just the direct
  ones: a project must be on the row's mayUse, and a library must be the stdlib, one of the row's
  libraries, or something one of those brings with it (LIBRARY_DEPENDENCIES).
  Why a walk and not Gradle dependency locking: a lockfile records what resolved, not what is
  allowed, so an agent that adds a library regenerates the lockfile in the same change and the build
  stays green. The walk checks the rule itself, and every version bump doesn't touch a lockfile.
*/
abstract class LayerResolutionCheck : DefaultTask() {
    @get:Input abstract val modulePath: Property<String>
    @get:Input abstract val mayUse: SetProperty<String>
    @get:Input abstract val libraries: SetProperty<String>
    @get:Input abstract val alwaysAllowed: SetProperty<String>
    // Each production classpath's resolved graph, by classpath name.
    @get:Input abstract val roots: MapProperty<String, ResolvedComponentResult>
    @get:Input abstract val fileArtifacts: SetProperty<String>
    @get:Internal abstract val declaredClasspath: ConfigurableFileCollection
    @get:Internal abstract val kotlinLibraries: ConfigurableFileCollection
    @get:Internal abstract val javaClasspath: ConfigurableFileCollection
    @get:Internal abstract val ownClasses: ConfigurableFileCollection

    @TaskAction
    fun check() {
        val module = modulePath.get()
        val problems = mutableListOf<String>()
        for ((classpath, root) in roots.get().toSortedMap()) {
            problems += componentProblems(module, classpath, root)
        }
        for (file in fileArtifacts.get().sorted()) {
            problems +=
                "module $module resolves file $file, which is neither a library nor a module, so LAYERS can't check it: depend on the library or module instead."
        }
        problems += compilerClasspathProblems(module, "compileKotlin", kotlinLibraries.files)
        problems += compilerClasspathProblems(module, "compileJava", javaClasspath.files)
        if (problems.isNotEmpty()) {
            throw GradleException(
                "Layer boundaries (build.gradle.kts → LAYERS, resolved):\n" +
                    problems.distinct().joinToString("\n") { "  - $it" }
            )
        }
    }

    // A compile task reading anything but compileClasspath (and this module's own classes, which
    // Java compiles against) compiles against something LAYERS never saw.
    private fun compilerClasspathProblems(
        module: String,
        task: String,
        files: Set<File>,
    ): List<String> {
        val declared = declaredClasspath.files
        val added = files - declared - ownClasses.files
        val dropped = declared - files
        if (added.isEmpty() && dropped.isEmpty()) return emptyList()
        val names = { set: Set<File> -> set.map { it.name }.sorted().joinToString() }
        return listOf(
            "task $module:$task compiles against a classpath that isn't its compileClasspath (added: ${names(added)}; dropped: ${names(dropped)}), which LAYERS checks: declare the dependency instead of adding it to the task."
        )
    }

    // Every edge of the resolved graph, from the module's own component outward.
    private fun componentProblems(
        module: String,
        classpath: String,
        root: ResolvedComponentResult,
    ): List<String> {
        val problems = mutableListOf<String>()
        val seen = mutableSetOf(root.id)
        val pending = ArrayDeque(listOf(root))
        while (pending.isNotEmpty()) {
            for (dependency in pending.removeFirst().dependencies) {
                if (dependency.isConstraint) continue
                val requested = dependency.requested
                val fixtures =
                    requested.requestedCapabilities.any { it.name.endsWith("-test-fixtures") } ||
                        (dependency is ResolvedDependencyResult &&
                            dependency.resolvedVariant.capabilities.any {
                                it.name.endsWith("-test-fixtures")
                            })
                if (fixtures) {
                    problems +=
                        "module $module resolves test fixtures of $requested on its $classpath: fakes are test code."
                }
                if (dependency !is ResolvedDependencyResult) {
                    problems +=
                        "module $module can't resolve $requested on its $classpath, so LAYERS can't check it."
                    continue
                }
                val selected = dependency.selected
                if (!seen.add(selected.id)) continue
                pending += selected
                problems += componentProblem(module, classpath, selected.id) ?: continue
            }
        }
        return problems
    }

    // What one resolved component breaks, if anything.
    private fun componentProblem(
        module: String,
        classpath: String,
        id: ComponentIdentifier,
    ): String? =
        when (id) {
            is ProjectComponentIdentifier ->
                if (id.projectPath in mayUse.get()) null
                else
                    "module $module resolves ${id.projectPath} on its $classpath, which its layer may not use (mayUse: ${mayUse.get()})."
            is ModuleComponentIdentifier -> {
                val library = "${id.group}:${id.module}"
                val allowed = libraries.get()
                if (library in alwaysAllowed.get() || "*" in allowed) null
                else
                    "module $module resolves library $library on its $classpath, which its layer does not allow (libraries: $allowed; what they bring: build.gradle.kts → LIBRARY_DEPENDENCIES)."
            }
            else -> "module $module resolves $id on its $classpath, which LAYERS can't classify."
        }
}

/*
  Scans compiled classes for references the module's row doesn't allow, by reading each class file's
  constant pool: class references, type descriptors (fields, parameters, Kotlin metadata), and member
  references. Bytecode, not source, so a fully qualified name, a typealias, an inline function from
  the standard library, or a Java file can't slip past an import rule. With an allowlist, every
  reference to a class not compiled in this module must be on it; then the denylist applies.
*/
abstract class BytecodeCheck : DefaultTask() {
    @get:Input abstract val modulePath: Property<String>
    @get:Input abstract val allowed: ListProperty<String>
    @get:Input abstract val forbidden: ListProperty<String>
    @get:InputFiles @get:SkipWhenEmpty abstract val classes: ConfigurableFileCollection

    @TaskAction
    fun scan() {
        val allowRules = allowed.get()
        val denyRules = forbidden.get()
        val module = modulePath.get()
        val classFiles =
            classes.files
                .filter { it.isDirectory }
                .flatMap { root ->
                    root
                        .walkTopDown()
                        .filter { it.isFile && it.extension == "class" }
                        .map { root to it }
                }
                .sortedBy { (root, file) -> file.relativeTo(root).invariantSeparatorsPath }
        // The module's own classes, from every compiler: references between them are always fine.
        val own =
            classFiles
                .map { (root, file) -> file.relativeTo(root).invariantSeparatorsPath }
                .map { it.removeSuffix(".class") }
                .toSet()
        val problems = mutableListOf<String>()
        for ((root, file) in classFiles) {
            val references = readReferences(file).sorted()
            val name = file.relativeTo(root).invariantSeparatorsPath
            if (allowRules.isNotEmpty()) {
                val outside = references.filter { reference ->
                    val referenceClass = reference.substringBefore('.')
                    // A primitive array's descriptor (`[I`) has no package.
                    '/' in referenceClass &&
                        referenceClass !in own &&
                        allowRules.none { allows(it, reference) }
                }
                if (outside.isNotEmpty()) {
                    problems +=
                        "e: $module $name references ${outside.joinToString()} (not on the LAYERS allowlist for $module): $ALLOWLIST_FIX"
                }
            }
            for (rule in denyRules) {
                val hits = references.filter { matches(rule, it) }
                if (hits.isEmpty()) continue
                problems +=
                    "e: $module $name references ${hits.joinToString()} (forbidden by LAYERS: $rule): $PORT_FIX_TEXT"
            }
        }
        if (problems.isNotEmpty()) {
            problems.forEach { logger.error(it) }
            throw GradleException(
                "Layer bytecode (build.gradle.kts → LAYERS bytecode), ${problems.size} finding(s):\n" +
                    problems.joinToString("\n")
            )
        }
    }

    // A rule split into its class part and its member part (null when it names no member).
    private fun parts(rule: String): Pair<String, String?> =
        if ('.' in rule.substringAfterLast('/'))
            rule.substringBeforeLast('.') to rule.substringAfterLast('.')
        else rule to null

    private fun classMatches(ruleClass: String, referenceClass: String): Boolean =
        when {
            ruleClass == "*" -> true
            ruleClass.endsWith("/**") -> referenceClass.startsWith(ruleClass.removeSuffix("**"))
            ruleClass.endsWith("/*") ->
                referenceClass.startsWith(ruleClass.removeSuffix("*")) &&
                    '/' !in referenceClass.removePrefix(ruleClass.removeSuffix("*"))
            ruleClass.endsWith("/") -> referenceClass.startsWith(ruleClass)
            else -> referenceClass == ruleClass || referenceClass.startsWith("$ruleClass$")
        }

    private fun memberMatches(ruleMember: String, referenceMember: String?): Boolean =
        referenceMember != null &&
            (if (ruleMember.endsWith("*")) referenceMember.startsWith(ruleMember.removeSuffix("*"))
            else referenceMember == ruleMember)

    // Whether one reference (a class `a/b/C`, or a member `a/b/C.name`) breaks one denylist rule.
    private fun matches(rule: String, reference: String): Boolean {
        val (ruleClass, ruleMember) = parts(rule)
        val referenceMember = if ('.' in reference) reference.substringAfter('.') else null
        return classMatches(ruleClass, reference.substringBefore('.')) &&
            (ruleMember == null || memberMatches(ruleMember, referenceMember))
    }

    // Whether one allowlist entry allows one reference. A member entry allows that member, and its
    // class as a type (no member), nothing else of the class.
    private fun allows(rule: String, reference: String): Boolean {
        val (ruleClass, ruleMember) = parts(rule)
        val referenceClass = reference.substringBefore('.')
        val referenceMember = if ('.' in reference) reference.substringAfter('.') else null
        if (ruleMember == null) return classMatches(ruleClass, referenceClass)
        return referenceClass == ruleClass &&
            (referenceMember == null || memberMatches(ruleMember, referenceMember))
    }

    // Every class and member a class file refers to, from its constant pool.
    private fun readReferences(file: File): Set<String> {
        val input = java.io.DataInputStream(file.inputStream().buffered())
        input.use {
            it.readInt() // magic
            it.readUnsignedShort() // minor
            it.readUnsignedShort() // major
            val count = it.readUnsignedShort()
            val utf8 = arrayOfNulls<String>(count)
            val classIndex = IntArray(count)
            val memberRefs = mutableListOf<Pair<Int, Int>>()
            val nameAndType = IntArray(count)
            val stringIndexes = mutableSetOf<Int>()
            var index = 1
            while (index < count) {
                when (val tag = it.readUnsignedByte()) {
                    1 -> utf8[index] = it.readUTF()
                    3,
                    4 -> it.readInt()
                    5,
                    6 -> {
                        it.readLong()
                        index++
                    }
                    7 -> classIndex[index] = it.readUnsignedShort()
                    8 -> stringIndexes += it.readUnsignedShort()
                    9,
                    10,
                    11 -> memberRefs += it.readUnsignedShort() to it.readUnsignedShort()
                    12 -> {
                        nameAndType[index] = it.readUnsignedShort()
                        it.readUnsignedShort()
                    }
                    15 -> {
                        it.readUnsignedByte()
                        it.readUnsignedShort()
                    }
                    16,
                    19,
                    20 -> it.readUnsignedShort()
                    17,
                    18 -> {
                        it.readUnsignedShort()
                        it.readUnsignedShort()
                    }
                    else -> throw GradleException("${file.name}: unknown constant-pool tag $tag")
                }
                index++
            }
            val references = mutableSetOf<String>()
            val descriptorType = Regex("L([\\w/$]+);")
            for (i in 1 until count) {
                val text = utf8[i] ?: continue
                // A string literal is data, not a reference.
                if (i in stringIndexes) continue
                descriptorType.findAll(text).forEach { match -> references += match.groupValues[1] }
            }
            for (i in 1 until count) {
                val name = classIndex[i].takeIf { it != 0 }?.let { utf8[it] } ?: continue
                references += name.trimStart('[').removePrefix("L").removeSuffix(";")
            }
            for ((owner, type) in memberRefs) {
                val ownerName = utf8[classIndex[owner]] ?: continue
                val memberName = utf8[nameAndType[type]] ?: continue
                references += "$ownerName.$memberName"
            }
            return references
        }
    }

    private companion object {
        const val PORT_FIX_TEXT =
            "put it behind a port in :usecases, implemented by an adapter in :data (docs/ports-and-adapters.md)."
        const val ALLOWLIST_FIX =
            "pure code takes the value as a parameter, and anything with an effect goes behind a port in :usecases (docs/ports-and-adapters.md); allowing a pure API is a decision (docs/decisions/), then add it to the row's allowlist."
    }
}

// Java in a module whose bytecode is checked: refused unless its row says allowsJava.
abstract class JavaSourceCheck : DefaultTask() {
    @get:Input abstract val modulePath: Property<String>
    @get:InputFiles @get:SkipWhenEmpty abstract val javaSources: ConfigurableFileCollection
    @get:Internal abstract val rootDirectory: Property<File>

    @TaskAction
    fun refuse() {
        val found = javaSources.files.filter { it.isFile }.sorted()
        if (found.isEmpty()) return
        val problems = found.map {
            "e: ${it.relativeToOrSelf(rootDirectory.get()).invariantSeparatorsPath}: Java source in ${modulePath.get()}, whose LAYERS row doesn't allow Java: write it in Kotlin, or set allowsJava on the row (a decision: docs/decisions/)."
        }
        problems.forEach { logger.error(it) }
        throw GradleException(
            "Java sources, ${problems.size} finding(s):\n" + problems.joinToString("\n")
        )
    }
}

/*
  `@Suppress("all")` silences every rule and `@Suppress("warnings")` every compiler warning (and
  Android's `@SuppressLint("all")` every lint check), and a suppression with no reason can't be
  reviewed. Every spelling counts (`@Suppress(…)`,
  `@file:Suppress(…)`, `@[Suppress(…)]`, `@file:[Suppress(…)]`, `kotlin.Suppress`,
  `SuppressWarnings`), found outside comments and string literals and read whole up to its closing
  paren, so a name on a later line counts. Each name must be a plain literal (`"MagicNumber"`), so
  a concatenation, a template, or a constant can't hide `all`, and an import alias or a typealias
  of `Suppress` is refused. A reason is a `//` line with text, above the annotation or after its
  closing paren. Lint's comment form, `//noinspection Id` (or `/* noinspection Id */`), follows the
  same rules: `ALL` is refused and the comment needs a `//` reason above it. In an Android module's
  XML (manifest, resources), `tools:ignore="all"` and `<!--suppress ALL -->` are refused too: the
  same switch, for lint, written in a resource. A named `tools:ignore` or `<!--suppress Id -->` needs
  no reason here (an XML comment is the convention, not checked): its
  reason would sit in a comment this regex-level scan can't tie to the attribute reliably.
*/
abstract class SuppressionCheck : DefaultTask() {
    @get:InputFiles @get:SkipWhenEmpty abstract val sources: ConfigurableFileCollection
    @get:Internal abstract val rootDirectory: Property<File>

    @TaskAction
    fun scan() {
        val problems = mutableListOf<String>()
        for (file in sources.asFileTree.matching { include("**/*.kt") }.files.sorted()) {
            val where = file.relativeToOrSelf(rootDirectory.get()).invariantSeparatorsPath
            problems += fileProblems(file.readText(), where)
        }
        for (file in sources.asFileTree.matching { include("**/*.xml") }.files.sorted()) {
            val where = file.relativeToOrSelf(rootDirectory.get()).invariantSeparatorsPath
            problems += xmlProblems(file.readText(), where)
        }
        if (problems.isNotEmpty()) {
            problems.forEach { logger.error(it) }
            throw GradleException(
                "Suppressions, ${problems.size} finding(s):\n" + problems.joinToString("\n")
            )
        }
    }

    // One file's findings, each a line starting `e: <file>:<line>`.
    private fun fileProblems(text: String, where: String): List<String> {
        // The text with comments and string literals blanked, so only code is searched.
        val code = codeOnly(text)
        val problems = mutableListOf<String>()
        for (match in ALIAS.findAll(code)) {
            problems +=
                "e: $where:${text.lineNumberAt(match.range.first)} an alias of Suppress (an import alias or a typealias) hides suppressions from checkSuppressions: use @Suppress itself."
        }
        for (match in SUPPRESS.findAll(code)) {
            val open = match.range.last + 1
            val close = closingParen(text, open)
            val line = text.lineNumberAt(match.range.first)
            val annotationProblems = mutableListOf<String>()
            for (argument in arguments(text.substring(open, close))) {
                val name = PLAIN_NAME.matchEntire(argument)?.groupValues?.get(1)
                if (name == null) {
                    annotationProblems +=
                        "e: $where:$line @${match.groupValues[1]} argument `$argument` is not a plain rule name: write each name as a \"RuleName\" literal."
                } else if (name.lowercase() in DENIED) {
                    annotationProblems +=
                        "e: $where:$line @${match.groupValues[1]}(\"$name\") silences every ${silenced(match.groupValues[1], name)}: name the one rule, with a // reason above it."
                }
            }
            problems += annotationProblems
            if (annotationProblems.isNotEmpty()) continue
            val lineStart = text.lastIndexOf('\n', match.range.first) + 1
            val above = text.substring(0, lineStart).lines().lastOrNull { it.isNotBlank() }?.trim()
            val afterClose = text.substring(minOf(close + 1, text.length)).substringBefore('\n')
            val reasonAbove =
                above?.startsWith("//") == true && above.removePrefix("//").isNotBlank()
            val reasonAfter = lineComment(afterClose)?.isNotBlank() == true
            if (!reasonAbove && !reasonAfter) {
                problems +=
                    "e: $where:$line @${match.groupValues[1]} with no reason: put a // line above it saying why (kotlin.mdc)."
            }
        }
        problems += noinspectionProblems(text, where)
        return problems
    }

    // Lint's comment form, `//noinspection Id` (or in a block comment or KDoc: lint only looks for
    // the word), quiets the next statement like @SuppressLint: `ALL` (any case) is refused, and the
    // comment needs a // reason on the line above it.
    private fun noinspectionProblems(text: String, where: String): List<String> {
        val problems = mutableListOf<String>()
        val lines = text.lines()
        for ((index, line) in lines.withIndex()) {
            val ids =
                NOINSPECTION_LINE.find(line)?.groupValues?.get(1)?.removeSuffix("*/") ?: continue
            if (ids.split(',', ' ').any { it.trim().equals("all", ignoreCase = true) }) {
                problems +=
                    "e: $where:${index + 1} //noinspection ALL silences every lint check: name the one check, with a // reason above it."
                continue
            }
            val above = lines.subList(0, index).lastOrNull { it.isNotBlank() }?.trim().orEmpty()
            val reason = above.takeIf { it.startsWith("//") }?.removePrefix("//")?.trim().orEmpty()
            val reasonAbove = reason.isNotEmpty() && NOINSPECTION_LINE.find(above) == null
            if (!reasonAbove) {
                problems +=
                    "e: $where:${index + 1} //noinspection with no reason: put a // line above it saying why (kotlin.mdc)."
            }
        }
        return problems
    }

    // What a denied name turns off, for the message.
    private fun silenced(annotation: String, name: String): String =
        when {
            annotation == "SuppressLint" -> "lint check"
            name.lowercase() == "all" -> "rule"
            else -> "compiler warning"
        }

    // An XML file's `tools:ignore` attributes that name `all` (any case, among other ids).
    private fun xmlProblems(text: String, where: String): List<String> =
        XML_SUPPRESS.findAll(text)
            .filter { match ->
                match.groupValues[1].split(',', ' ').any {
                    it.trim().equals("all", ignoreCase = true)
                }
            }
            .map {
                "e: $where:${text.lineNumberAt(it.range.first)} <!--suppress ${it.groupValues[1].trim()} --> silences every lint check: name the one check, with an XML comment saying why."
            }
            .toList() +
            TOOLS_IGNORE.findAll(text)
                .filter { match ->
                    match.groupValues[1].split(',').any {
                        it.trim().equals("all", ignoreCase = true)
                    }
                }
                .map {
                    "e: $where:${text.lineNumberAt(it.range.first)} tools:ignore=\"${it.groupValues[1]}\" silences every lint check: name the one check, with an XML comment saying why."
                }
                .toList()

    private fun String.lineNumberAt(index: Int): Int = take(index).count { it == '\n' } + 1

    // The text with every comment and string or char literal replaced by spaces (newlines kept),
    // so a match's index is the same in both. Block comments nest, as in Kotlin.
    private fun codeOnly(text: String): String {
        val code = StringBuilder(text)
        val blank = { from: Int, to: Int ->
            for (i in from until minOf(to, text.length)) if (text[i] != '\n') code[i] = ' '
        }
        var index = 0
        while (index < text.length) {
            when {
                text.startsWith("//", index) -> {
                    val end = text.indexOf('\n', index).takeIf { it >= 0 } ?: text.length
                    blank(index, end)
                    index = end
                }
                text.startsWith("/*", index) -> {
                    var depth = 0
                    var end = index
                    while (end < text.length) {
                        if (text.startsWith("/*", end)) {
                            depth++
                            end += 2
                        } else if (text.startsWith("*/", end)) {
                            depth--
                            end += 2
                            if (depth == 0) break
                        } else end++
                    }
                    blank(index, end)
                    index = end
                }
                text[index] == '"' -> {
                    val end = endOfString(text, index) + 1
                    blank(index, end)
                    index = end
                }
                text[index] == '\'' -> {
                    val end = endOfChar(text, index) + 1
                    blank(index, end)
                    index = end
                }
                else -> index++
            }
        }
        return code.toString()
    }

    // An annotation's arguments, split at top-level commas, trimmed, whitespace collapsed; a
    // trailing comma adds nothing.
    private fun arguments(inside: String): List<String> {
        val found = mutableListOf<String>()
        var depth = 0
        var start = 0
        var index = 0
        while (index < inside.length) {
            when (inside[index]) {
                '"' -> index = endOfString(inside, index)
                '\'' -> index = endOfChar(inside, index)
                '(',
                '[',
                '{' -> depth++
                ')',
                ']',
                '}' -> depth--
                ',' ->
                    if (depth == 0) {
                        found += inside.substring(start, index)
                        start = index + 1
                    }
            }
            index++
        }
        found += inside.substring(minOf(start, inside.length))
        return found.map { it.trim().replace(Regex("\\s+"), " ") }.filter { it.isNotEmpty() }
    }

    // The index of the paren closing the one opened just before `from` (string literals and nested
    // parens skipped), or the end of the text.
    private fun closingParen(text: String, from: Int): Int {
        var depth = 1
        var index = from
        while (index < text.length) {
            when (text[index]) {
                '"' -> index = endOfString(text, index)
                '(' -> depth++
                ')' -> if (--depth == 0) return index
            }
            index++
        }
        return text.length
    }

    // The index of the last quote of the string literal starting at `start` (raw or escaped).
    private fun endOfString(text: String, start: Int): Int {
        if (text.startsWith("\"\"\"", start)) {
            val end = text.indexOf("\"\"\"", start + 3)
            return if (end < 0) text.length else end + 2
        }
        var index = start + 1
        while (index < text.length && text[index] != '"' && text[index] != '\n') {
            if (text[index] == '\\') index++
            index++
        }
        return index
    }

    // The index of the closing quote of the char literal starting at `start`: 'x' or an escape
    // like '\'' or 'A'.
    private fun endOfChar(text: String, start: Int): Int {
        val body = if (text.getOrNull(start + 1) == '\\') start + 3 else start + 2
        return text.indexOf('\'', minOf(body, text.length)).takeIf { it >= 0 } ?: text.length
    }

    // The text of a `//` comment on this line outside any string or char literal, or null.
    private fun lineComment(line: String): String? {
        var index = 0
        while (index < line.length) {
            when {
                line[index] == '"' -> index = endOfString(line, index)
                line[index] == '\'' -> index = endOfChar(line, index)
                line.startsWith("//", index) -> return line.substring(index + 2)
            }
            index++
        }
        return null
    }

    private companion object {
        // Names that turn off everything at once.
        val DENIED = setOf("all", "warnings")

        // Any spelling of the annotation (Android's SuppressLint too), at the start of its argument
        // list; group 1 is its name.
        val SUPPRESS =
            Regex(
                """(?<![\w.])(?:kotlin\.|java\.lang\.|android\.annotation\.)?(Suppress(?:Warnings|Lint)?)\s*\("""
            )

        // A plain rule name: letters, digits (lint's SetTextI18n), underscores (compiler
        // diagnostics), and dots.
        val PLAIN_NAME = Regex(""""([A-Za-z0-9_.]+)"""")

        // A line whose comment (`//`, `/*`, `/**`, or a KDoc `*` line) starts `noinspection
        // Id[,Id…]`;
        // group 1 is its ids (a block comment's `*/` still on the end).
        val NOINSPECTION_LINE = Regex("""(?://|/\*+|^\s*\*)\s*noinspection\s+([^\n]*)""")

        // Lint's XML comment form, `<!--suppress Id[,Id…] -->`; group 1 is its ids.
        val XML_SUPPRESS = Regex("""<!--\s*suppress\s+([^>]*?)\s*-->""")

        // A `tools:ignore="…"` attribute (lint's suppression in XML); group 1 is its ids.
        val TOOLS_IGNORE = Regex("""\btools:ignore\s*=\s*["']([^"']*)["']""")

        // `import kotlin.Suppress as X` and `typealias X = Suppress` (and SuppressLint).
        val ALIAS =
            Regex(
                """\bimport\s+(?:kotlin\.|java\.lang\.|android\.annotation\.)?Suppress(?:Warnings|Lint)?\s+as\b|\btypealias\s+\w+(?:\s*<[^>]*>)?\s*=\s*(?:kotlin\.|java\.lang\.|android\.annotation\.)?Suppress(?:Warnings|Lint)?\b"""
            )
    }
}

// Counts the tests a test task actually ran (not skipped) into a file, from the run's root suite.
class RanTestsRecorder(private val countFile: File) : TestListener {
    override fun beforeSuite(suite: TestDescriptor) = Unit

    override fun beforeTest(testDescriptor: TestDescriptor) = Unit

    override fun afterTest(testDescriptor: TestDescriptor, result: TestResult) = Unit

    override fun afterSuite(suite: TestDescriptor, result: TestResult) {
        if (suite.parent != null) return
        countFile.parentFile.mkdirs()
        countFile.writeText("${result.testCount - result.skippedTestCount}")
    }
}

// A test task that ran nothing (every test @Disabled, the test file deleted, an empty
// @TestFactory) passes on its own.
abstract class TestsRanCheck : DefaultTask() {
    @get:Input abstract val modulePath: Property<String>
    @get:Internal abstract val results: RegularFileProperty

    @TaskAction
    fun count() {
        val file = results.get().asFile
        val ran = if (file.isFile) file.readText().trim().toIntOrNull() ?: 0 else 0
        if (ran == 0) {
            throw GradleException(
                "module ${modulePath.get()} ran 0 tests (skipped ones and an empty @TestFactory don't count); its LAYERS row requires tests: restore or un-disable them."
            )
        }
    }
}
