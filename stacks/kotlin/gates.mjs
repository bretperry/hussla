#!/usr/bin/env node
// Proves the Kotlin pack's boundary, lint, and test gates still bite: plants a violation of each on a scratch copy and fails unless the build reports it.
// In the app: nothing at runtime; `pnpm kotlin:gates`, one of the Kotlin pack's checks (pnpm check, CI).
// Used by: stacks/kotlin/pack.json `checks` (script `kotlin:gates`).
// Uses: ./gradlew (a JDK 21): `printLayers` for the layer map, `help` and `check` on scratch copies; config/detekt/detekt.yml.
//
// Why this exists: a gate that matches nothing is silent. Rename a module and forget its LAYERS
// row, move the domain and leave detekt's `includes` glob behind, drop a rule or a task from
// `check`, and `./gradlew check` stays green while a boundary is off. So the gates are tested, not
// trusted: each probe breaks one rule in a scratch copy, and the build must fail naming it. The
// rows themselves can't be trusted either (a row emptied of its rules has nothing left to probe),
// so the samples here are also a floor the rows must meet.
//
// Nothing here names a module or a package: the layer map comes from the build (`printLayers`), so
// a project that renames packages or adds a module keeps working. A row marked `android` (the
// composition root, built by the Android Gradle Plugin) gets its own probes: Android lint and the
// settings that would quiet it, @SuppressLint and tools:ignore, and its variant-named tasks; the
// logic rows get one more, an Android API that must not compile in them. Probes are
// grouped so one failure can't hide another: a build file that refuses to configure stops every
// task, and a module that won't compile stops its own lint and bytecode scan. Nothing is written
// to the real tree but the stamp, under build/.

// Node builtins, and the floors and stamp beside this file.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { floorProblems, gateStamp, recordPass, shouldSkip, STAMP_FILE } from "./gates-lib.mjs";

// Knob: one scratch build's timeout. A cold Gradle daemon and dependency cache are the slow case.
const BUILD_TIMEOUT_MS = 300_000;

// Knob: a library no inner layer may use, and its version, for the "domain takes no libraries" probes.
const SOME_LIBRARY = "org.jetbrains.kotlinx:kotlinx-coroutines-core";
const SOME_LIBRARY_VERSION = "1.11.0";
// Knob: two more small libraries (no dependencies of their own, so each probe reports only its
// own), one added by a component metadata rule and one swapped in by substitution.
const METADATA_LIBRARY = "org.opentest4j:opentest4j:1.3.0";
const SUBSTITUTED_LIBRARY = "org.apiguardian:apiguardian-api:1.1.2";

// Knob: one Kotlin expression per bytecode denylist rule (build.gradle.kts → LAYERS `bytecode`),
// each written fully qualified, so only the bytecode scan can see it. A rule with no sample fails
// the gates: add one here when you add a rule. A sample no row uses fails too, so these are the
// floor: dropping a rule from a row means deleting its sample here, in the same reviewed diff.
const BYTECODE_SAMPLES = {
  "java/io/": 'java.io.File("x").exists()',
  "java/net/": 'java.net.URI.create("x")',
  "java/sql/": "java.sql.DriverManager.getDrivers()",
  "java/nio/file/": 'java.nio.file.Paths.get("x")',
  "java/nio/channels/": "java.nio.channels.Pipe.open()",
  // kotlin.io.path.Path is inline (its bytecode is java.nio), so this calls a function that stays in kotlin.io.path.
  "kotlin/io/path/": ["import kotlin.io.path.listDirectoryEntries", 'java.nio.file.Paths.get("x").listDirectoryEntries()'],
  "kotlin/io/ConsoleKt": "readln()",
  "java/lang/ProcessBuilder": 'ProcessBuilder("x")',
  "java/lang/Runtime": "Runtime.getRuntime()",
  "java/lang/Thread": "Thread {}",
  "kotlin/concurrent/": "kotlin.concurrent.thread {}",
  "java/util/prefs/": "java.util.prefs.Preferences.userRoot()",
  "java/util/logging/": 'java.util.logging.Logger.getLogger("x")',
  "java/lang/System.getLogger": 'System.getLogger("x")',
  "java/lang/reflect/": "java.lang.reflect.Array.getLength(arrayOf(1))",
  "java/lang/ClassLoader": "ClassLoader.getSystemClassLoader()",
  "java/lang/Class.forName": 'Class.forName("x")',
  "java/lang/Class.getMethod*": 'String::class.java.getMethod("length")',
  "java/lang/Class.getConstructor*": "String::class.java.constructors",
  "java/lang/Class.getDeclared*": "String::class.java.declaredFields",
  "java/lang/Class.getField*": "String::class.java.fields",
  "java/lang/Class.getResource*": 'String::class.java.getResource("x")',
  "java/lang/invoke/MethodHandles.*": "java.lang.invoke.MethodHandles.lookup()",
  // Members of classes the pure layer's allowlist lets in.
  "java/lang/Math.random": "Math.random()",
  "java/lang/StrictMath.random": "StrictMath.random()",
  "java/lang/String.format": '"%d".format(1)',
  "java/lang/Integer.getInteger": 'java.lang.Integer.getInteger("x")',
  "java/lang/Long.getLong": 'java.lang.Long.getLong("x")',
  "java/lang/Boolean.getBoolean": 'java.lang.Boolean.getBoolean("x")',
  "*.printStackTrace": "IllegalStateException(\"x\").printStackTrace()",
  "java/util/Collections.shuffle": "java.util.Collections.shuffle(mutableListOf(1))",
  "java/util/UUID.randomUUID": "java.util.UUID.randomUUID()",
  // Any package under kotlin/, not only collections: sequences and ranges have their own.
  "kotlin/**.random*": "(1..2).random()",
  "kotlin/**.shuffle*": "sequenceOf(1).shuffled()",
  "java/time/*.now": "java.time.LocalDate.now()",
  "java/time/chrono/*.dateNow": "java.time.chrono.IsoChronology.INSTANCE.dateNow()",
  "java/time/Clock": "java.time.Clock.systemUTC()",
  "java/time/InstantSource": "java.time.InstantSource.system()",
  "java/time/*.systemDefault": "java.time.ZoneId.systemDefault()",
  "java/time/format/DateTimeFormatter.ofPattern": 'java.time.format.DateTimeFormatter.ofPattern("yyyy")',
  "java/time/format/DateTimeFormatter.ofLocalized*": "java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.SHORT)",
  "java/nio/charset/Charset.defaultCharset": "java.nio.charset.Charset.defaultCharset()",
  // A use-case's process, thread-pool, timer, and by-name loading rules.
  "java/lang/ProcessHandle": "ProcessHandle.current()",
  "java/lang/System.exit": "System.exit(0)",
  "java/lang/System.load*": 'System.loadLibrary("x")',
  "java/util/concurrent/Executors": "java.util.concurrent.Executors.newSingleThreadExecutor()",
  "java/util/concurrent/ThreadPoolExecutor": "java.util.concurrent.ThreadPoolExecutor(1, 1, 1L, java.util.concurrent.TimeUnit.SECONDS, java.util.concurrent.LinkedBlockingQueue<Runnable>())",
  "java/util/concurrent/ScheduledThreadPoolExecutor": "java.util.concurrent.ScheduledThreadPoolExecutor(1)",
  "java/util/concurrent/ForkJoinPool": "java.util.concurrent.ForkJoinPool.commonPool()",
  "java/util/Timer": "java.util.Timer()",
  "java/util/zip/": "java.util.zip.CRC32()",
  "java/util/ServiceLoader": "java.util.ServiceLoader.load(Runnable::class.java)",
  "java/beans/": 'java.beans.Introspector.decapitalize("X")',
  "javax/naming/": "javax.naming.InitialContext()",
  "java/rmi/": 'java.rmi.Naming.list("x")',
  "jdk/": "jdk.jfr.FlightRecorder.isAvailable()",
};

// Knob: what a row with a bytecode allowlist (the pure layer) must refuse, one sample per family:
// I/O, network, storage, processes, threads, the environment, logging, preferences, reflection
// (including a class loaded by a computed name), the clock, and randomness. Each is planted in every
// such row; a widened allowlist that lets one through fails the gates. The clock and random ids
// inside allowed packages (java.time, UUID) are BYTECODE_SAMPLES, refused by the row's denylist.
const OUTSIDE_ALLOWLIST_SAMPLES = [
  'java.io.File("x").exists()',
  'java.io.File("x").readText()',
  'println("x")',
  "readln()",
  'java.net.URI.create("x")',
  'java.nio.file.Paths.get("x")',
  "java.sql.DriverManager.getDrivers()",
  'javax.crypto.Cipher.getInstance("AES")',
  'ProcessBuilder("x")',
  "Runtime.getRuntime()",
  "ProcessHandle.current()",
  "kotlin.system.exitProcess(0)",
  "Thread {}",
  "kotlin.concurrent.thread {}",
  "java.util.concurrent.Executors.newSingleThreadExecutor()",
  "java.util.Timer()",
  'System.getenv("X")',
  'System.getProperty("x")',
  "System.getProperties()",
  'System.setProperty("x", "y")',
  "java.lang.management.ManagementFactory.getRuntimeMXBean()",
  'java.util.logging.Logger.getLogger("x")',
  'System.getLogger("x")',
  "java.util.prefs.Preferences.userRoot()",
  'Class.forName("x")',
  'String::class.java.getMethod("length")',
  'String::class.java.classLoader.loadClass("java.io." + "File").getMethod("delete").invoke(null)',
  "java.lang.invoke.MethodHandles.lookup()",
  "java.lang.reflect.Array.getLength(arrayOf(1))",
  "System.currentTimeMillis()",
  "System.nanoTime()",
  "java.util.Date()",
  "java.util.Calendar.getInstance()",
  "java.util.TimeZone.getDefault()",
  "java.util.Locale.getDefault()",
  "kotlin.time.Clock.System",
  "kotlin.time.TimeSource.Monotonic.markNow()",
  "kotlin.time.measureTime {}",
  "java.util.Random()",
  "java.security.SecureRandom()",
  "kotlin.random.Random.nextInt()",
];

// Knob: ordinary pure Kotlin the pure layer's allowlist must let through (the corpus gate): enums
// under `when`, sealed types, value classes, collections, text, numbers, dates, ids, encodings.
// Planted whole in every row with an allowlist; `checkBytecode` must pass. A narrowed allowlist
// that refuses everyday code fails here instead of in a project.
const PURE_CORPUS = `import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.util.TreeMap
import java.util.TreeSet
import java.util.UUID
import kotlin.io.encoding.Base64
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

enum class ZzCorpusColor {
    Red,
    Green,
}

sealed interface ZzCorpusShape {
    data class Circle(val radius: Double) : ZzCorpusShape

    data object Empty : ZzCorpusShape
}

@JvmInline value class ZzCorpusId(val value: String)

object ZzCorpus {
    fun label(color: ZzCorpusColor): String =
        when (color) {
            ZzCorpusColor.Red -> "r"
            ZzCorpusColor.Green -> "g"
        }

    fun area(shape: ZzCorpusShape): Double =
        when (shape) {
            is ZzCorpusShape.Circle -> kotlin.math.PI * shape.radius * shape.radius
            ZzCorpusShape.Empty -> 0.0
        }

    fun bytes(text: String): ByteArray = text.toByteArray()

    fun decoded(bytes: ByteArray): String = bytes.decodeToString()

    fun money(text: String): BigDecimal = BigDecimal(text).setScale(2, RoundingMode.HALF_EVEN)

    fun date(): LocalDate = LocalDate.of(2026, 1, 2).plusDays(3)

    fun parsedDate(text: String): LocalDate = LocalDate.parse(text)

    fun javaDuration(): java.time.Duration = java.time.Duration.ofSeconds(3)

    @OptIn(ExperimentalTime::class) fun instant(millis: Long): Instant = Instant.fromEpochMilliseconds(millis)

    fun uuid(text: String): UUID = UUID.fromString(text)

    fun sorted(counts: Map<String, Int>): java.util.SortedMap<String, Int> = counts.toSortedMap()

    fun tree(): TreeMap<String, Int> = TreeMap<String, Int>().apply { put("a", 1) }

    fun navigable(): java.util.NavigableSet<Int> = TreeSet(listOf(3, 1, 2))

    fun base64(bytes: ByteArray): String = Base64.encode(bytes)

    fun grouped(words: List<String>): Map<Int, List<String>> = words.filter { it.isNotBlank() }.groupBy { it.length }

    fun matches(text: String): Boolean = Regex("[a-z]+").matches(text)

    fun timeout(): Duration = 5.seconds

    fun repeated(times: Int): String = buildString { repeat(times) { append(it) } }

    fun checked(count: Int): Int {
        require(count >= 0) { "count must not be negative" }
        return count.coerceAtMost(10)
    }

    fun upper(text: String): String = text.uppercase()

    fun firstThree(): List<Int> = generateSequence(1) { it + 1 }.take(3).toList()

    fun byRadius(circles: List<ZzCorpusShape.Circle>): List<ZzCorpusShape.Circle> = circles.sortedWith(compareBy { it.radius })

    fun id(text: String): ZzCorpusId = ZzCorpusId(text.trim())

    fun colors(): List<ZzCorpusColor> = ZzCorpusColor.entries.toList()
}
`;

// Knob: imports detekt's ForbiddenImport must refuse in the innermost layer (detekt.yml). `android.*`
// isn't here: on a JVM-only build it doesn't compile, so the compiler already refuses it.
const FORBIDDEN_IMPORTS = [
  "java.io.File",
  "java.nio.file.Path",
  "java.net.URI",
  "java.sql.Connection",
  "java.util.concurrent.Executors",
  "java.time.Clock",
  "javax.crypto.Cipher",
  "kotlin.io.path.Path",
  "kotlin.time.Clock",
];

// The project root is the working directory the core (or you) runs this in.
const root = process.cwd();
const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";

// Stops with a message; a failed gate is never a quiet exit.
const fail = (message) => {
  process.stderr.write(`kotlin gates: ${message}\n`);
  process.exit(1);
};

// The hash of what the gates read, taken once, before the layer map or any scratch copy: a pass
// is recorded under this value, so it names the tree the probes actually ran against.
const stampAtStart = gateStamp(root);

// A local run skips when nothing the gates read has changed since they last passed here (every
// Gradle script, gradle/, buildSrc/, included builds, detekt config, these scripts, the package
// directories). CI always runs them. Delete the stamp to force a local run.
if (shouldSkip(root, process.env, stampAtStart)) {
  process.stdout.write(`kotlin gates: skipped, nothing they read changed since they last passed (${STAMP_FILE}; CI=true or deleting it forces a run).\n`);
  process.exit(0);
}

// Runs the wrapper in `dir`; a build that can't start (no JDK) stops the gates.
const gradle = (dir, args) => {
  const result = spawnSync(gradlew, [...args, "--console=plain"], { cwd: dir, encoding: "utf8", timeout: BUILD_TIMEOUT_MS, shell: process.platform === "win32" });
  if (result.error !== undefined) fail(`could not run ${gradlew}: ${result.error.message}. It needs a JDK 21 (kotlin.mdc → Tools).`);
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

// The layer map, from the real build.
const printed = gradle(root, ["-q", "printLayers"]);
const jsonLine = printed.output.split("\n").find((line) => line.startsWith("LAYERS_JSON "));
if (printed.status !== 0 || jsonLine === undefined) fail(`\`./gradlew printLayers\` failed; fix the build first.\n${printed.output.slice(-2000)}`);
const layers = JSON.parse(jsonLine.slice("LAYERS_JSON ".length));

// Every row must name a module that holds Kotlin, or a gate could guard an empty module.
for (const row of layers) {
  if (row.dir === "" || row.package === "") fail(`LAYERS row ${row.path} has no module with Kotlin under src/main/kotlin; the gates would be guarding nothing.`);
}
const byPath = Object.fromEntries(layers.map((row) => [row.path, row]));
const packageDir = (row) => `${row.dir}/src/main/kotlin/${row.package.replaceAll(".", "/")}`;
// An Android row's tasks are named by variant (AGP builds unit tests for debug only).
const testTaskOf = (row) => (row.android ? "testDebugUnitTest" : "test");
const compileTaskOf = (row) => (row.android ? "compileDebugKotlin" : "compileKotlin");
const jvmLayers = layers.filter((row) => !row.android);
const androidLayers = layers.filter((row) => row.android);
// The innermost layers: no module and no library allowed.
const inner = jvmLayers.filter((row) => row.mayUse.length === 0 && row.libraries.length === 0);
if (inner.length === 0) fail("no LAYERS row is pure (no mayUse, no libraries); the domain gates have nowhere to plant.");
const domain = inner[0];
// A module a row may not depend on, if any.
const forbiddenModuleFor = (row) => layers.find((other) => other.path !== row.path && !row.mayUse.includes(other.path));
const withTests = layers.filter((row) => existsSync(join(root, row.dir, "src/test")));

// Floors: a probe only proves what its row asks for, so a weakened row would weaken its probes with
// it. These refuse the weakened rows themselves (gates-lib.mjs, tested in gates.test.mjs).
const floors = floorProblems(layers, Object.keys(BYTECODE_SAMPLES));
if (floors.length > 0) fail(floors.join("\n"));

// Probe builders. A probe: what it plants (a function of the scratch dir), the texts one output
// line must all hold, what it proves, and the task (`:module:task`) that must fail for it. A
// finding printed by a task that still passed (ignoreFailures) proves nothing, so a probe that
// names a task needs that task's `FAILED` line too.
const probe = (plant, expect, proves, task) => ({ plant, expect, proves, task });
const buildFile = (row) => `${row.dir}/build.gradle.kts`;
const appendTo = (path, text) => (dir) => appendFileSync(join(dir, path), text);
// A new file, in a directory that may not exist yet.
const writeTo = (path, text) => (dir) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const addDependency = (row, line) => appendTo(buildFile(row), `\ndependencies {\n    ${line}\n}\n`);
const addSource = (row, file, body) => (dir) => {
  const path = join(dir, packageDir(row), file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `package ${row.package}\n\n${body}`);
};

// Group 1: configuration. The layer map refuses the build before any task runs and lists every
// violation at once, so these share one copy and one `./gradlew help`.
const configuration = [];
for (const row of layers) {
  const other = forbiddenModuleFor(row);
  if (other !== undefined) configuration.push(probe(addDependency(row, `implementation(project("${other.path}"))`), [`module ${row.path} depends on ${other.path} (declared in implementation)`], `${row.path} may not depend on ${other.path}`));
}
configuration.push(
  probe(addDependency(domain, `implementation("${SOME_LIBRARY}:${SOME_LIBRARY_VERSION}")`), [`module ${domain.path} uses library ${SOME_LIBRARY}`], "the domain takes no libraries"),
  probe(addDependency(domain, 'implementation(files("zz-gate.jar"))'), [`module ${domain.path} uses library files`, "zz-gate.jar"], "a files() dependency is a library, named by its file"),
  probe(
    (dir) => {
      mkdirSync(join(dir, "zzgate"), { recursive: true });
      writeFileSync(join(dir, "zzgate/build.gradle.kts"), "");
      appendFileSync(join(dir, "settings.gradle.kts"), '\ninclude(":zzgate")\n');
    },
    ["module :zzgate has no row in LAYERS"],
    "a new module can't skip the layer map",
  ),
  probe(appendTo(`${domain.dir}/detekt-baseline.xml`, "<SmellBaseline/>\n"), [`${domain.dir}/detekt-baseline.xml is a detekt baseline`], "a detekt baseline can't silence findings"),
  probe(
    appendTo(buildFile(domain), '\nextensions.configure<dev.detekt.gradle.extensions.DetektExtension> { baseline.set(file("gradle/zz-known-issues.xml")) }\n'),
    [`module ${domain.path}: the detekt extension sets a baseline`, "zz-known-issues.xml"],
    "a baseline set on detekt's extension, under any name, can't silence findings",
  ),
  // Settings that let a gate fail while the build stays green.
  probe(appendTo(buildFile(domain), "\nextensions.configure<dev.detekt.gradle.extensions.DetektExtension> { ignoreFailures.set(true) }\n"), [`module ${domain.path}: the detekt extension sets ignoreFailures`], "detekt's extension can't set ignoreFailures"),
  probe(
    appendTo(buildFile(domain), "\nextensions.configure<dev.detekt.gradle.extensions.DetektExtension> { failOnSeverity.set(dev.detekt.gradle.extensions.FailOnSeverity.Never) }\n"),
    [`module ${domain.path}: the detekt extension sets failOnSeverity Never`],
    "detekt's extension can't set failOnSeverity Never",
  ),
);
// The task-level switches, each in a module the extension probes above don't touch.
const switchRow = jvmLayers.find((row) => row.path !== domain.path) ?? domain;
const lastRow = jvmLayers.at(-1);
configuration.push(
  probe(appendTo(buildFile(switchRow), "\ntasks.withType<Test>().configureEach { ignoreFailures = true }\n"), [`task ${switchRow.path}:${testTaskOf(switchRow)} sets ignoreFailures`], "a test task can't set ignoreFailures"),
  probe(appendTo(buildFile(switchRow), "\ntasks.withType<dev.detekt.gradle.Detekt>().configureEach { ignoreFailures.set(true) }\n"), [`task ${switchRow.path}:detektMain sets ignoreFailures`], "a detekt task can't set ignoreFailures"),
  probe(
    appendTo(buildFile(lastRow), "\ntasks.withType<dev.detekt.gradle.Detekt>().configureEach { failOnSeverity.set(dev.detekt.gradle.extensions.FailOnSeverity.Never) }\n"),
    [`task ${lastRow.path}:detektMain sets failOnSeverity Never`],
    "a detekt task can't set failOnSeverity Never",
  ),
);
// A row that may use some module: test fixtures, a configuration extended into implementation, and
// a source directory borrowed from elsewhere each smuggle code past the map.
const user = jvmLayers.find((row) => row.mayUse.length > 0);
if (user !== undefined) {
  const allowed = user.mayUse[0];
  const other = forbiddenModuleFor(user);
  configuration.push(probe(addDependency(user, `implementation(testFixtures(project("${allowed}")))`), [`module ${user.path} depends on test fixtures of ${allowed}`], "production code can't use test fixtures"));
  configuration.push(
    probe(
      appendTo(buildFile(user), '\ntasks.withType<dev.detekt.gradle.Detekt>().configureEach { baseline.set(file("zz-known.xml")) }\n'),
      [`task ${user.path}:detektMain sets a detekt baseline`, "zz-known.xml"],
      "a baseline set on a detekt task can't silence findings",
    ),
  );
  if (other !== undefined) {
    configuration.push(
      probe(
        appendTo(buildFile(user), `\nval zzGate = configurations.create("zzGate")\nconfigurations.named("implementation") { extendsFrom(zzGate) }\ndependencies.add("zzGate", project("${other.path}"))\n`),
        [`module ${user.path} depends on ${other.path} (declared in zzGate)`],
        "a configuration extended into implementation is checked too",
      ),
    );
  }
  configuration.push(
    probe(
      appendTo(buildFile(user), '\nextensions.getByType<org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension>().sourceSets.getByName("main").kotlin.srcDir("../zzgate-borrowed")\n'),
      [`module ${user.path}: source directory zzgate-borrowed`, "outside the module"],
      "a module can't compile another directory's code",
    ),
  );
}

// An Android row: every setting that would quiet Android lint while the build stays green.
const configureAndroid = (row, body) => appendTo(buildFile(row), `\nextensions.configure<com.android.build.api.dsl.ApplicationExtension> { lint { ${body} } }\n`);
for (const row of androidLayers) {
  configuration.push(
    probe(configureAndroid(row, "abortOnError = false"), [`module ${row.path}: lint sets abortOnError false`], `${row.path}: lint can't stop failing the build`),
    probe(configureAndroid(row, "warningsAsErrors = false"), [`module ${row.path}: lint sets warningsAsErrors false`], `${row.path}: lint warnings stay errors`),
    probe(configureAndroid(row, "ignoreWarnings = true"), [`module ${row.path}: lint sets ignoreWarnings`], `${row.path}: lint can't ignore warnings`),
    probe(configureAndroid(row, 'baseline = file("zz-lint-known.xml")'), [`module ${row.path}: lint sets a baseline`, "zz-lint-known.xml"], `${row.path}: a lint baseline can't silence findings`),
    probe(configureAndroid(row, 'lintConfig = file("zz-lint-config.xml")'), [`module ${row.path}: lint reads a config file`, "zz-lint-config.xml"], `${row.path}: lint can't read a config file that turns checks off`),
    probe(configureAndroid(row, 'checkOnly += "ZzGateOnly"'), [`module ${row.path}: lint sets checkOnly`, "ZzGateOnly"], `${row.path}: lint can't be narrowed to a few checks`),
    probe(configureAndroid(row, 'disable += "ZzGateDisabled"'), [`module ${row.path}: lint disable`, "ZzGateDisabled"], `${row.path}: lint can't turn a check off outside LINT_DISABLED`),
    probe(configureAndroid(row, 'ignore += "ZzGateIgnored"'), [`module ${row.path}: lint ignore`, "ZzGateIgnored"], `${row.path}: lint can't ignore a check outside LINT_DISABLED`),
    probe(configureAndroid(row, 'informational += "ZzGateInformational"'), [`module ${row.path}: lint informational`, "ZzGateInformational"], `${row.path}: lint can't turn a check down to informational`),
    probe(appendTo(`${row.dir}/lint.xml`, "<lint/>\n"), [`${row.dir}/lint.xml is a lint config file`], `${row.path}: a lint.xml can't turn checks off`),
  );
}
// Lint reads a lint.xml from every directory above a module too; the root one is the shared case.
// "- " anchors it to the root's own line, not a module's.
if (androidLayers.length > 0) configuration.push(probe(appendTo("lint.xml", "<lint/>\n"), ["- lint.xml is a lint config file"], "a lint.xml at the root can't turn checks off"));

// Group 2: a project repository fails configuration on its own (FAIL_ON_PROJECT_REPOS).
const repositories = [probe(appendTo(buildFile(domain), "\nrepositories { mavenCentral() }\n"), ["was added by build file", buildFile(domain)], "repositories come only from settings.gradle.kts")];

// A test source file with this body, in place of the module's tests.
const replaceTests = (row, file, body) => (dir) => {
  rmSync(join(dir, row.dir, "src/test"), { recursive: true, force: true });
  const path = join(dir, row.dir, "src/test/kotlin", row.package.replaceAll(".", "/"), file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `package ${row.package}\n\n${body}`);
};
const testsRequired = withTests.filter((row) => byPath[row.path].requiresTests);

// Group 3: a cross-layer import doesn't compile, which stops that module and every module that
// uses it, so it goes in the outermost row that has a module it may not use. A module that
// doesn't use that row still builds here, so its tests get the empty-@TestFactory probe.
const compile = [];
const crossLayer = layers.findLast((row) => forbiddenModuleFor(row) !== undefined);
if (crossLayer !== undefined) {
  const other = forbiddenModuleFor(crossLayer);
  compile.push(probe(addSource(crossLayer, "ZzGateCrossLayer.kt", `import ${other.package}.*\n`), ["ZzGateCrossLayer.kt", "Unresolved reference"], `${crossLayer.path} can't import ${other.path} (the compiler refuses it)`, `${crossLayer.path}:${compileTaskOf(crossLayer)}`));
}
const factoryRow = testsRequired.find((row) => !row.android && row.path !== crossLayer?.path && !row.mayUse.includes(crossLayer?.path));
if (factoryRow === undefined) fail("the empty-@TestFactory gate needs a module with tests and `requiresTests` that doesn't use the cross-layer probe's module.");
compile.push(
  probe(
    replaceTests(factoryRow, "ZzGateEmptyFactory.kt", "import org.junit.jupiter.api.DynamicTest\nimport org.junit.jupiter.api.TestFactory\n\nclass ZzGateEmptyFactory {\n    @TestFactory fun none(): List<DynamicTest> = emptyList()\n}\n"),
    [`module ${factoryRow.path} ran 0 tests`],
    "checkTestsRan: an @TestFactory that makes no tests ran none",
    `${factoryRow.path}:checkTestsRan`,
  ),
);

// Group 4: a compiler warning fails the build (allWarningsAsErrors), which also stops that module.
const warnings = [probe(addSource(domain, "ZzGateWarning.kt", "fun zzGateWarning(): Int? = \"x\"?.length\n"), ["warnings found and -Werror specified"], "compiler warnings are errors", `${domain.path}:compileKotlin`)];
// An Android row's own, in a build of its own: the domain's warning above stops every module that
// uses the domain from compiling, the composition root included.
const androidWarnings = androidLayers.map((row) => probe(addSource(row, "ZzGateWarning.kt", "fun zzGateWarning(): Int? = \"x\"?.length\n"), ["warnings found and -Werror specified"], `compiler warnings are errors in ${row.path} (AGP's built-in Kotlin)`, `${row.path}:compileDebugKotlin`));

// Group 5: everything `./gradlew check` must report, in one run with --continue.
const check = [];
// One function per file, returning the sample. A sample is an expression, or [an import line, an expression].
// Each sample is its own object, so its own class file names it in a finding. The samples share one
// source file per row (fewer files to lint and format), except one that needs an import.
const addSample = (row, file, objectName, sample) => (dir) => {
  const [imports, expression] = Array.isArray(sample) ? [`${sample[0]}\n\n`, sample[1]] : ["", sample];
  const declaration = `\nobject ${objectName} {\n    @OptIn(kotlin.time.ExperimentalTime::class) fun sample(): Any? = ${expression}\n}\n`;
  const path = join(dir, packageDir(row), imports === "" ? file : `${objectName}.kt`);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, `package ${row.package}\n\n${imports}`);
  appendFileSync(path, declaration);
};
// Group 6: every bytecode sample, built and scanned with only `checkBytecode` (no lint, format, or
// tests: these prove the scan, and the scan's place in `check` is proved below, once per row).
const bytecode = [];
for (const row of layers) {
  row.bytecode.forEach((rule, index) => {
    const sample = BYTECODE_SAMPLES[rule];
    if (sample === undefined) fail(`no probe for bytecode rule "${rule}" (${row.path}): add a sample to BYTECODE_SAMPLES in stacks/kotlin/gates.mjs.`);
    const name = `ZzGateBytecode${index}`;
    bytecode.push(probe(addSample(row, "ZzGateBytecode.kt", name, sample), [`/${name}.class`, `forbidden by LAYERS: ${rule}`], `${row.path}'s bytecode may not reference ${rule} (written fully qualified)`, `${row.path}:checkBytecode`));
  });
  OUTSIDE_ALLOWLIST_SAMPLES.forEach((sample, index) => {
    if (row.bytecodeAllowed.length === 0) return;
    const name = `ZzGateOutside${index}`;
    bytecode.push(probe(addSample(row, "ZzGateOutside.kt", name, sample), [`/${name}.class`, "not on the LAYERS allowlist"], `${row.path}'s allowlist refuses \`${sample}\``, `${row.path}:checkBytecode`));
  });
  // A class that breaks one rule twice is reported with both references, not just the first.
  if (row.bytecode.includes("java/io/")) {
    bytecode.push(probe(addSample(row, "ZzGateBytecode.kt", "ZzGateAllHits", 'java.io.File("x").exists() && java.io.File("y").delete()'), ["/ZzGateAllHits.class", "java/io/File.delete", "java/io/File.exists", "forbidden by LAYERS: java/io/"], `${row.path}'s scan reports every hit of a rule in a class`, `${row.path}:checkBytecode`));
  }
  // `check` runs the scan: one sample per scanned row, in the check group.
  const [rule] = row.bytecode;
  if (row.bytecodeAllowed.length > 0) check.push(probe(addSample(row, "ZzGateInCheck.kt", "ZzGateInCheck", OUTSIDE_ALLOWLIST_SAMPLES[0]), ["/ZzGateInCheck.class", "not on the LAYERS allowlist"], `\`check\` runs ${row.path}'s bytecode scan`, `${row.path}:checkBytecode`));
  else if (rule !== undefined) check.push(probe(addSample(row, "ZzGateInCheck.kt", "ZzGateInCheck", BYTECODE_SAMPLES[rule]), ["/ZzGateInCheck.class", `forbidden by LAYERS: ${rule}`], `\`check\` runs ${row.path}'s bytecode scan`, `${row.path}:checkBytecode`));
}
// Java compiles to its own classes directory, which the scan reads too; a row that doesn't allow
// Java refuses the source as well.
const javaRow = layers.find((row) => row.bytecodeAllowed.length > 0 || row.bytecode.includes("java/io/"));
if (javaRow === undefined) fail("no LAYERS row refuses java.io, so the Java bytecode probe has nowhere to plant; update the probe.");
check.push(
  probe(
    (dir) => {
      const path = join(dir, javaRow.dir, "src/main/java", javaRow.package.replaceAll(".", "/"), "ZzGateJava.java");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `package ${javaRow.package};\n\npublic final class ZzGateJava {\n    public static boolean zzGateJava() {\n        return new java.io.File("x").delete();\n    }\n}\n`);
    },
    ["ZzGateJava.class", "java/io/File"],
    `${javaRow.path}'s bytecode scan reads Java classes too`,
    `${javaRow.path}:checkBytecode`,
  ),
);
if (!javaRow.allowsJava) check.push(probe(() => {}, ["ZzGateJava.java", `Java source in ${javaRow.path}`], `checkJavaSources: ${javaRow.path} takes no Java`, `${javaRow.path}:checkJavaSources`));
FORBIDDEN_IMPORTS.forEach((imported, index) => {
  check.push(probe(addSource(domain, `ZzGateImport${index}.kt`, `import ${imported}\n`), [`ZzGateImport${index}.kt`, "[ForbiddenImport]"], `detekt refuses \`import ${imported}\` in ${domain.path}`, `${domain.path}:detektMain`));
});
// A source file planted as written, header lines and all.
const addRawSource = (row, file, text) => (dir) => {
  const path = join(dir, packageDir(row), file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
check.push(
  probe(addSource(domain, "ZzGateMagic.kt", "fun zzGateMagic(days: Long): Long = days * 86_400\n"), ["ZzGateMagic.kt", "[MagicNumber]"], "detekt MagicNumber: a number the product retunes is a named knob", `${domain.path}:detektMain`),
  probe(addSource(domain, "ZzGateCall.kt", 'fun zzGateCall(): String? = System.getenv("X")\n'), ["ZzGateCall.kt", "[ForbiddenMethodCall]"], "detekt ForbiddenMethodCall: no hidden environment read", `${domain.path}:detektMain`),
  probe(addSource(domain, "ZzGateFormat.kt", "fun   zzGateFormat( ) =   1\n"), ["Invalid formatting", "ZzGateFormat.kt"], "ktfmt runs in check", `${domain.path}:ktfmtCheckMain`),
);
// checkSuppressions: every spelling of the annotation, every way to hide a name, and the reason.
const suppression = (file, body, expect, proves) => probe(addSource(domain, file, body), [file, expect], proves, `${domain.path}:checkSuppressions`);
check.push(
  suppression("ZzGateSuppressAll.kt", '@Suppress("all") fun zzGateSuppressAll() = Unit\n', '@Suppress("all")', 'checkSuppressions refuses @Suppress("all")'),
  suppression("ZzGateSuppressBare.kt", '@Suppress("MagicNumber") fun zzGateSuppressBare() = 7\n', "@Suppress with no reason", "checkSuppressions wants a // reason"),
  probe(
    addRawSource(domain, "ZzGateSuppressWarnings.kt", `// ok\n@file:Suppress("warnings")\n\npackage ${domain.package}\n\nfun zzGateSuppressWarnings() = Unit\n`),
    ["ZzGateSuppressWarnings.kt", '@Suppress("warnings")'],
    'checkSuppressions refuses @file:Suppress("warnings"), reason or not',
    `${domain.path}:checkSuppressions`,
  ),
  suppression("ZzGateSuppressMultiline.kt", '// a reason\n@Suppress(\n    "MagicNumber",\n    "all",\n)\nfun zzGateSuppressMultiline() = 7\n', '@Suppress("all")', "checkSuppressions reads a multi-line @Suppress to its closing paren"),
  suppression("ZzGateSuppressString.kt", '@Suppress("MagicNumber") fun zzGateSuppressString() = "http://x" + 7\n', "@Suppress with no reason", "checkSuppressions: a // inside a string literal is no reason"),
  suppression("ZzGateSuppressBracket.kt", '// a reason\n@[Suppress("all")]\nfun zzGateSuppressBracket() = Unit\n', '@Suppress("all")', 'checkSuppressions reads @[Suppress("all")]'),
  probe(
    addRawSource(domain, "ZzGateSuppressFileBracket.kt", `// a reason\n@file:[Suppress("warnings")]\n\npackage ${domain.package}\n\nfun zzGateSuppressFileBracket() = Unit\n`),
    ["ZzGateSuppressFileBracket.kt", '@Suppress("warnings")'],
    'checkSuppressions reads @file:[Suppress("warnings")]',
    `${domain.path}:checkSuppressions`,
  ),
  suppression("ZzGateSuppressConcat.kt", '// a reason\n@Suppress("a" + "ll")\nfun zzGateSuppressConcat() = Unit\n', "is not a plain rule name", "checkSuppressions refuses a concatenated name"),
  suppression("ZzGateSuppressConstant.kt", 'const val ZZ_GATE_ALL = "all"\n\n// a reason\n@Suppress(ZZ_GATE_ALL)\nfun zzGateSuppressConstant() = Unit\n', "is not a plain rule name", "checkSuppressions refuses a name held in a constant"),
  suppression("ZzGateSuppressImportAlias.kt", 'import kotlin.Suppress as ZzQuiet\n\n// a reason\n@ZzQuiet("all")\nfun zzGateSuppressImportAlias() = Unit\n', "an alias of Suppress", "checkSuppressions refuses an import alias of Suppress"),
  suppression("ZzGateSuppressTypealias.kt", 'typealias ZzHush = Suppress\n\n// a reason\n@ZzHush("all")\nfun zzGateSuppressTypealias() = Unit\n', "an alias of Suppress", "checkSuppressions refuses a typealias of Suppress"),
  suppression("ZzGateSuppressEmptyReason.kt", '//\n@Suppress("MagicNumber")\nfun zzGateSuppressEmptyReason() = 7\n', "@Suppress with no reason", "checkSuppressions: an empty // is no reason"),
);
// An empty jar (just the end-of-archive record), so a compiler that reads it still compiles.
const EMPTY_JAR = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]);
const addJar = (row, file) => (dir) => writeFileSync(join(dir, row.dir, file), EMPTY_JAR);
const layerResolution = (plant, expect, proves) => probe(plant, expect, proves, `${domain.path}:checkLayerResolution`);
check.push(
  layerResolution(
    appendTo(buildFile(domain), `\nconfigurations.named("implementation") { withDependencies { add(project.dependencies.create("${SOME_LIBRARY}:${SOME_LIBRARY_VERSION}")) } }\n`),
    [`module ${domain.path} resolves library ${SOME_LIBRARY} `],
    "checkLayerResolution sees a dependency added during resolution",
  ),
  // A library the stdlib's metadata is made to depend on: not a direct dependency of the module.
  layerResolution(
    appendTo(buildFile(domain), `\ndependencies.components.withModule("org.jetbrains.kotlin:kotlin-stdlib") { withVariant("jvmApiElements") { withDependencies { add("${METADATA_LIBRARY}") } } }\n`),
    [`module ${domain.path} resolves library ${METADATA_LIBRARY.split(":").slice(0, 2).join(":")} `],
    "checkLayerResolution walks every resolved component (a component metadata rule)",
  ),
  // A library swapped in for one the stdlib brings.
  layerResolution(
    appendTo(buildFile(domain), `\nconfigurations.named("compileClasspath") { resolutionStrategy.dependencySubstitution { substitute(module("org.jetbrains:annotations")).using(module("${SUBSTITUTED_LIBRARY}")) } }\n`),
    [`module ${domain.path} resolves library ${SUBSTITUTED_LIBRARY.split(":").slice(0, 2).join(":")} `],
    "checkLayerResolution walks every resolved component (a substitution)",
  ),
  // A file added during resolution, which the declared-dependency check never sees.
  layerResolution(
    (dir) => {
      addJar(domain, "zz-gate-resolved.jar")(dir);
      appendTo(buildFile(domain), '\nconfigurations.named("implementation") { withDependencies { add(project.dependencies.create(files("zz-gate-resolved.jar"))) } }\n')(dir);
    },
    [`module ${domain.path} resolves file zz-gate-resolved.jar`],
    "checkLayerResolution refuses a file on a classpath (added during resolution)",
  ),
  // Files handed to the compilers directly, past every configuration.
  layerResolution(
    (dir) => {
      addJar(domain, "zz-gate-libraries.jar")(dir);
      appendTo(buildFile(domain), '\ntasks.named<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>("compileKotlin") { libraries.from(files("zz-gate-libraries.jar")) }\n')(dir);
    },
    [`task ${domain.path}:compileKotlin compiles against a classpath that isn't its compileClasspath`, "zz-gate-libraries.jar"],
    "checkLayerResolution refuses compileKotlin.libraries beyond compileClasspath",
  ),
  layerResolution(
    (dir) => {
      addJar(domain, "zz-gate-java.jar")(dir);
      appendTo(buildFile(domain), '\ntasks.named<JavaCompile>("compileJava") { classpath += files("zz-gate-java.jar") }\n')(dir);
    },
    [`task ${domain.path}:compileJava compiles against a classpath that isn't its compileClasspath`, "zz-gate-java.jar"],
    "checkLayerResolution refuses compileJava.classpath beyond compileClasspath",
  ),
);
// Test fixtures added during resolution, which the build files never declare.
const fixturesRow = layers.find((row) => existsSync(join(root, row.dir, "src/testFixtures")));
const fixturesUser = fixturesRow && layers.find((row) => row.mayUse.includes(fixturesRow.path));
if (fixturesUser === undefined) fail("no module has test fixtures and a user, so the resolved-fixtures probe has nowhere to plant; update the probe.");
check.push(
  probe(
    appendTo(buildFile(fixturesUser), `\nconfigurations.named("implementation") { withDependencies { add(project.dependencies.testFixtures(project.dependencies.project(mapOf("path" to "${fixturesRow.path}")))) } }\n`),
    [`module ${fixturesUser.path} resolves test fixtures of`],
    "checkLayerResolution sees test fixtures added during resolution",
    `${fixturesUser.path}:checkLayerResolution`,
  ),
);
const coroutineRow = layers.find((row) => row.libraries.includes(SOME_LIBRARY));
if (coroutineRow === undefined) fail(`no LAYERS row allows ${SOME_LIBRARY}, so the GlobalCoroutineUsage probe has nowhere to compile; update the probe.`);
check.push(
  probe(
    addSource(coroutineRow, "ZzGateGlobal.kt", "import kotlinx.coroutines.GlobalScope\nimport kotlinx.coroutines.launch\n\n@OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)\nfun zzGateGlobal() = GlobalScope.launch {}\n"),
    ["ZzGateGlobal.kt", "[GlobalCoroutineUsage]"],
    "detekt GlobalCoroutineUsage",
    `${coroutineRow.path}:detektMain`,
  ),
);
// Tests: a module whose row requires tests and has none, and a test task that discovers none.
const jvmTestsRequired = testsRequired.filter((row) => !row.android);
if (jvmTestsRequired.length < 2) fail("the test gates need two Kotlin/JVM modules with tests and `requiresTests` (one to empty, one to break discovery).");
const [emptied, undiscovered] = jvmTestsRequired;
check.push(
  probe((dir) => rmSync(join(dir, emptied.dir, "src/test"), { recursive: true, force: true }), [`module ${emptied.path} ran 0 tests`], "checkTestsRan: a module that requires tests can't run none", `${emptied.path}:checkTestsRan`),
  probe(replaceTests(undiscovered, "ZzGateNoTests.kt", "class ZzGateNoTests {\n    fun notATest() = Unit\n}\n"), ["did not discover any tests"], "Gradle fails a test task that finds no tests (failOnNoDiscoveredTests)", `${undiscovered.path}:test`),
);

// An Android row: lint runs in `check` and a warning fails it, detekt runs type-resolved per variant,
// ktfmt runs, its unit tests are counted, and lint's own suppressions are held to the same rules.
for (const row of androidLayers) {
  check.push(
    probe(
      // An unused resource: lint's UnusedResources is a warning, so this proves warningsAsErrors too.
      writeTo(`${row.dir}/src/main/res/values/zz_gate_lint.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="zz_gate_unused">zz</string>\n</resources>\n'),
      ["zz_gate_lint.xml", "Error:", "[UnusedResources]"],
      `Android lint runs in \`check\` on ${row.path}, and a warning fails it`,
      `${row.path}:lintDebug`,
    ),
    probe(addSource(row, "ZzGateMagic.kt", "fun zzGateMagic(days: Long): Long = days * 86_400\n"), ["ZzGateMagic.kt", "[MagicNumber]"], `detekt runs type-resolved in \`check\` on ${row.path}`, `${row.path}:detektDebug`),
    probe(addSource(row, "ZzGateFormat.kt", "fun   zzGateFormat( ) =   1\n"), ["Invalid formatting", "ZzGateFormat.kt"], `ktfmt runs in check on ${row.path}`, `${row.path}:ktfmtCheckMain`),
    probe(addSource(row, "ZzGateSuppressLint.kt", '// a reason\n@android.annotation.SuppressLint("all")\nfun zzGateSuppressLint() = Unit\n'), ["ZzGateSuppressLint.kt", '@SuppressLint("all")'], `checkSuppressions refuses @SuppressLint("all") in ${row.path}`, `${row.path}:checkSuppressions`),
    probe(
      writeTo(`${row.dir}/src/main/res/values/zz_gate_ignore.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources xmlns:tools="http://schemas.android.com/tools" tools:ignore="UnusedResources,All">\n    <string name="zz_gate">zz</string>\n</resources>\n'),
      ["zz_gate_ignore.xml", 'tools:ignore="UnusedResources,All"'],
      `checkSuppressions refuses tools:ignore="all" in ${row.path}'s resources`,
      `${row.path}:checkSuppressions`,
    ),
  );
  // A production source set other than main (a build type here) is policed the same way.
  check.push(
    probe(
      writeTo(`${row.dir}/src/debug/kotlin/${row.package.replaceAll(".", "/")}/ZzGateDebugSuppress.kt`, `package ${row.package}\n\n// a reason\n@android.annotation.SuppressLint("all")\nfun zzGateDebugSuppress() = Unit\n`),
      ["ZzGateDebugSuppress.kt", '@SuppressLint("all")'],
      `checkSuppressions reads ${row.path}'s debug source set, not only main`,
      `${row.path}:checkSuppressions`,
    ),
    probe(addSource(row, "ZzGateNoinspectionAll.kt", "// a reason\n//noinspection ALL\nfun zzGateNoinspectionAll() = Unit\n"), ["ZzGateNoinspectionAll.kt", "//noinspection ALL"], `checkSuppressions refuses //noinspection ALL in ${row.path}`, `${row.path}:checkSuppressions`),
    probe(addSource(row, "ZzGateBlockNoinspection.kt", "// a reason\n/* noinspection ALL */\nfun zzGateBlockNoinspection() = Unit\n"), ["ZzGateBlockNoinspection.kt", "//noinspection ALL"], `checkSuppressions refuses /* noinspection ALL */ in ${row.path}`, `${row.path}:checkSuppressions`),
    probe(
      writeTo(`${row.dir}/src/main/res/values/zz_gate_suppress.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <!--suppress ALL -->\n    <string name="zz_gate_suppressed">zz</string>\n</resources>\n'),
      ["zz_gate_suppress.xml", "<!--suppress ALL -->"],
      `checkSuppressions refuses <!--suppress ALL --> in ${row.path}'s resources`,
      `${row.path}:checkSuppressions`,
    ),
    probe(
      (dir) => {
        appendTo(buildFile(row), '\nextensions.configure<com.android.build.api.dsl.ApplicationExtension> { sourceSets.getByName("main").res.directories.add("zz-extra-res") }\n')(dir);
        writeTo(`${row.dir}/zz-extra-res/values/zz_gate_extra.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources xmlns:tools="http://schemas.android.com/tools" tools:ignore="all">\n    <string name="zz_gate_extra">zz</string>\n</resources>\n')(dir);
      },
      ["zz_gate_extra.xml", 'tools:ignore="all"'],
      `checkSuppressions reads a resource directory a build file adds to ${row.path}`,
      `${row.path}:checkSuppressions`,
    ),
    probe(addSource(row, "ZzGateNoinspectionBare.kt", "val zzGateBefore = 1\n\n//noinspection SetTextI18n\nfun zzGateNoinspectionBare() = Unit\n"), ["ZzGateNoinspectionBare.kt", "//noinspection with no reason"], `checkSuppressions wants a reason above //noinspection in ${row.path}`, `${row.path}:checkSuppressions`),
    probe(addSource(row, "ZzGateSuppressLintBare.kt", "val zzGateBefore2 = 1\n\n@android.annotation.SuppressLint(\"SetTextI18n\")\nfun zzGateSuppressLintBare() = Unit\n"), ["ZzGateSuppressLintBare.kt", "@SuppressLint with no reason"], `checkSuppressions wants a reason above @SuppressLint in ${row.path}`, `${row.path}:checkSuppressions`),
  );
  if (row.requiresTests) check.push(probe((dir) => rmSync(join(dir, row.dir, "src/test"), { recursive: true, force: true }), [`module ${row.path} ran 0 tests`], `checkTestsRan: ${row.path} requires tests, counted on ${testTaskOf(row)}`, `${row.path}:checkTestsRan`));
}

// A failing test fails its test task (and so `check`): planted beside the real tests of the last
// module that requires them, run in the bytecode group (which builds but doesn't test otherwise).
const failingTestRow = testsRequired.at(-1);
bytecode.push(
  probe(
    (dir) => {
      const path = join(dir, failingTestRow.dir, "src/test/kotlin", failingTestRow.package.replaceAll(".", "/"), "ZzGateFailingTest.kt");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `package ${failingTestRow.package}\n\nimport org.junit.jupiter.api.Test\n\nclass ZzGateFailingTest {\n    @Test fun zzGateFails(): Unit = throw AssertionError("zz gate: a planted failing test")\n}\n`);
    },
    ["ZzGateFailingTest", "FAILED"],
    "a failing test fails its test task",
    `${failingTestRow.path}:${testTaskOf(failingTestRow)}`,
  ),
);

// Group 8, one per logic row (Kotlin/JVM, not an adapter): an Android API doesn't compile there, so
// the logic stays host-testable. One build each, since a module that doesn't compile stops every
// module that uses it.
const androidApi =
  androidLayers.length === 0
    ? []
    : jvmLayers
        .filter((row) => !row.libraries.includes("*"))
        .map((row) => [
          `android-api ${row.path}`,
          [probe(addSource(row, "ZzGateAndroidApi.kt", "fun zzGateAndroidApi(): Int = android.os.Build.VERSION.SDK_INT\n"), ["ZzGateAndroidApi.kt", "Unresolved reference"], `${row.path} can't use an Android API`, `${row.path}:compileKotlin`)],
          [`${row.path}:compileKotlin`],
        ]);

// An Android row's reasoned lint suppressions pass checkSuppressions: a lint id with a digit
// (SetTextI18n) is a plain name, and a // reason above satisfies both forms.
const androidSuppressions = androidLayers.map((row) =>
  probe(addSource(row, "ZzGateReasoned.kt", '// a reason\n@android.annotation.SuppressLint("SetTextI18n")\nfun zzGateReasoned() = Unit\n\n// a reason\n//noinspection SetTextI18n\nfun zzGateReasonedComment() = Unit\n'), [], `reasoned @SuppressLint("SetTextI18n") and //noinspection pass ${row.path}'s checkSuppressions`),
);

// The last JVM row, so it isn't the domain the disabled probes already change.
const unwired = jvmLayers.at(-1);
// A gate task turned off in a module's build file fails the build before any task runs, so these
// get their own build: one per gate family, on the Android row and a JVM row.
const disabled = [
  ...androidLayers.map((row) => probe(appendTo(buildFile(row), '\ntasks.matching { it.name == "lintDebug" }.configureEach { enabled = false }\n'), [`${row.path}:lintDebug is disabled`], `${row.path}: lint can't be turned off as a task`)),
  probe(appendTo(buildFile(domain), '\ntasks.matching { it.name == "detektMain" }.configureEach { enabled = false }\n'), [`${domain.path}:detektMain is disabled`], `${domain.path}: detekt can't be turned off as a task`),
  probe(appendTo(buildFile(domain), '\ntasks.matching { it.name == "checkSuppressions" }.configureEach { enabled = false }\n'), [`${domain.path}:checkSuppressions is disabled`], `${domain.path}: checkSuppressions can't be turned off`),
  // Left out of the graph instead: excluded by name, or unwired from `check`. Other tasks and rows
  // than the ones above, since a task that never joins the graph isn't reported as disabled.
  ...androidLayers.map((row) => probe(appendTo(buildFile(row), `\ngradle.startParameter.excludedTaskNames.add("${row.path}:detektDebug")\n`), [`${row.path}:detektDebug doesn't run with ${row.path}:check`], `${row.path}: a gate can't be excluded from the build`)),
  probe(appendTo(buildFile(unwired), '\ntasks.named("check") { setDependsOn(emptyList<Any>()) }\n'), [`${unwired.path}:checkSuppressions doesn't run with ${unwired.path}:check`], `${unwired.path}: check's gates can't be unwired`),
];

// Group 7, the corpus: ordinary pure Kotlin planted in every row with an allowlist must pass its
// scan, so the allowlist can't drift into refusing everyday code.
const corpus = [];
const corpusTasks = [];
for (const row of jvmLayers.filter((each) => each.bytecodeAllowed.length > 0)) {
  corpus.push(probe(addSource(row, "ZzCorpus.kt", PURE_CORPUS), [], `ordinary pure Kotlin passes ${row.path}'s allowlist (PURE_CORPUS)`));
  corpusTasks.push(`${row.path}:checkBytecode`);
}

// A scratch copy of the whole project (every included module, wherever it lives) minus build
// output, caches, and other stacks' installs.
const SKIP = new Set(["build", ".gradle", ".kotlin", "node_modules", ".git"]);
const scratchCopy = () => {
  const dir = mkdtempSync(join(tmpdir(), "kotlin-gates-"));
  for (const name of readdirSync(root)) {
    if (SKIP.has(name)) continue;
    cpSync(join(root, name), join(dir, name), { recursive: true, filter: (source) => !SKIP.has(source.split(/[\\/]/).at(-1) ?? "") });
  }
  return dir;
};

// Plants a group in one scratch copy, runs the build, and returns the probes it didn't report.
// A group that must pass (the corpus) misses every probe when its build fails.
const runGroup = (name, probes, args, mustPass = false) => {
  const dir = scratchCopy();
  try {
    for (const { plant } of probes) plant(dir);
    const started = Date.now();
    const { status, output } = gradle(dir, args);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (mustPass) return { name, missed: status === 0 ? [] : probes, output, seconds };
    const lines = output.split("\n");
    // Its finding on one line, and its task's FAILED line when it names a task.
    const reported = ({ expect, task }) => lines.some((line) => expect.every((text) => line.includes(text))) && (task === undefined || lines.some((line) => line.trim() === `> Task ${task} FAILED`));
    // A build that passed reported nothing, whatever it printed.
    const missed = status === 0 ? probes : probes.filter((planted) => !reported(planted));
    return { name, missed, output, seconds };
  } finally {
    // KOTLIN_GATES_KEEP=1 keeps each scratch copy for a look (its path is printed).
    if (process.env.KOTLIN_GATES_KEEP === "1") process.stderr.write(`kotlin gates: kept ${name} scratch copy at ${dir}\n`);
    else rmSync(dir, { recursive: true, force: true });
  }
};

// A check-group probe that names no task could be "reported" by a task that printed it and passed.
for (const { proves, task } of check) {
  if (task === undefined) fail(`check-group probe "${proves}" names no task: give it the task whose FAILED line proves it.`);
}

const groups = [
  ["configuration", configuration, ["help"]],
  ["repositories", repositories, ["help"]],
  ["compile", compile, ["check", "--continue"]],
  ["warnings", warnings, ["check", "--continue"]],
  ["android warnings", androidWarnings, androidWarnings.map(({ task }) => task)],
  ["check", check, ["check", "--continue"]],
  // `--rerun`: a test task restored from the build cache runs nothing, and its cache key leaves out
  // ignoreFailures, so one passing run with it set would make the failing test pass from cache.
  ["bytecode", bytecode, ["checkBytecode", `${failingTestRow.path}:${testTaskOf(failingTestRow)}`, "--rerun", "--continue"]],
  ["corpus", corpus, corpusTasks, true],
  ["android suppressions", androidSuppressions, androidLayers.map((row) => `${row.path}:checkSuppressions`), true],
  ["disabled tasks", disabled, ["check", "--dry-run"]],
  ...androidApi,
];
// One build at a time: side by side they share one machine's cores and a second daemon, and took
// longer in total.
const runs = groups.filter(([, probes]) => probes.length > 0).map(([name, probes, args, mustPass]) => runGroup(name, probes, args, mustPass));
const total = groups.reduce((sum, [, probes]) => sum + probes.length, 0);
const missed = runs.flatMap((run) => run.missed);
if (missed.length > 0) {
  process.stderr.write(`kotlin gates: ${missed.length} of ${total} gates did not hold. Each planted violation must fail its task, and the corpus must pass; a gate that says nothing here would say nothing about real code.\n`);
  for (const { expect, proves, task } of missed) process.stderr.write(`  ✗ ${proves}: ${expect.length === 0 ? "expected the build to pass" : `expected a line with ${expect.map((text) => `"${text}"`).join(" and ")}`}${task === undefined ? "" : ` and "> Task ${task} FAILED"`}\n`);
  for (const run of runs.filter((each) => each.missed.length > 0)) {
    // Findings and the failure summary; with none (the build passed), its last lines.
    const all = run.output.split("\n");
    const findings = all.filter((line) => line.startsWith("e:") || line.includes("  - ") || line.includes("What went wrong") || line.includes("Invalid formatting"));
    const shown = findings.length > 0 ? findings.slice(0, 40) : all.filter((line) => line.trim() !== "").slice(-15);
    process.stderr.write(`\nthe scratch build (${run.name}) said:\n${shown.join("\n")}\n`);
  }
  process.exit(1);
}
process.stdout.write(`kotlin gates: all ${total} gates held (${runs.length} scratch builds: ${runs.map((run) => `${run.name} ${run.seconds}s`).join(", ")}).\n`);
// Passed: the next local run skips until something the gates read changes, unless something
// already changed while they ran (then the scratch copies may have missed it, so no stamp).
if (!recordPass(root, stampAtStart)) process.stdout.write(`kotlin gates: stamp not written: a file the gates read changed during this run, so the next run checks it.\n`);
