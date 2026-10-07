// The C++ pack's evaluated checks: what CMake actually configured, what the compiler actually included, and what each layer's objects call.
// In the app: nothing at runtime; `pnpm cpp:build` (so `pnpm check` and CI) runs it on every build tree; the edit hook runs the configure half.
// Used by: stacks/cpp/run.mjs, stacks/cpp/gates.mjs, stacks/cpp/check-edited.mjs; tested by stacks/cpp/evaluated.test.mjs.
// Uses: cmake (File API: codemodel-v2, toolchains-v1), ninja (`-t deps`), nm; cpp-layers.json, CMakePresets.json (via stacks/cpp/sources.mjs).
//
// CMakeLists.txt and the presets are code, and a text scan of them misses a flag added through a
// variable, a preset, or a source property. So this reads the result instead:
// - configured (File API): every first-party target is a layer row or a test executable; a layer
//   compiles only files under cpp/<layer>/, links only the layers its row allows, and sees only
//   their include directories (a refused link is followed, since CMake reports a link cycle as a
//   chain); every first-party compile is C++ (a C file would escape the flag checks), has no SYSTEM
//   include of ours, has the warning floor and no -Wno-*/-w/--no-warnings/-isystem,
//   C++20 or later without GNU extensions, and the preset's sanitizers (asan: address + undefined
//   that abort; tsan: thread) on compile and link, with no recover or ignore list; the compiler is
//   the preset's (clang for the sanitizer trees, gcc for the second-compiler tree).
// - included (ninja's deps, after a build): a layer's objects include no header outside its own
//   directory and its allowed layers' include/ dirs. That catches `#include "../../adapters/…"`,
//   which the include path never saw.
// - called (nm, after a build): a layer's objects reference no symbol in a family its row denies
//   (getenv is env; system_clock::now is clock; std::ofstream is io …), however the call was spelled.
// Threat model (cpp.mdc): drift and gate-disabling settings, not determined evasion.

// Node builtins only, plus this pack's own scripts.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LAYER_MAP, layerOfPath, mayReach, readLayerMap, repoPath, SOURCE_ROOT } from "./sources.mjs";
import { failure, limit, run } from "./tool.mjs";

// Knob: where every build tree lives (each preset's binaryDir is BUILD_ROOT/<preset>; .gitignore keeps it out of git).
export const BUILD_ROOT = "build-cpp";

// Knob: the presets the pack builds, and what each must evaluate to. `ci: true` runs only under
// CI=true (the second compiler costs a cold build and finds little a sanitizer tree doesn't).
export const PRESETS = {
  asan: { compiler: "Clang", sanitize: ["address", "undefined"], noRecover: true, ci: false },
  tsan: { compiler: "Clang", sanitize: ["thread"], noRecover: false, ci: false },
  gcc: { compiler: "GNU", sanitize: [], noRecover: false, ci: true },
};

// Knob: the warning floor every first-party compile carries (CMakeLists.txt CPP_WARNINGS may add more).
export const REQUIRED_WARNINGS = ["-Wall", "-Wextra", "-Wpedantic", "-Wconversion", "-Wsign-conversion", "-Wshadow", "-Wold-style-cast", "-Wnon-virtual-dtor", "-Woverloaded-virtual", "-Wimplicit-fallthrough", "-Werror"];

// Knob: the oldest language standard a first-party target may compile as.
export const MIN_STANDARD = 20;

// Knob: how long a configure may take (a cold one downloads GoogleTest), and a build (cold, one tree).
export const CONFIGURE_TIMEOUT_MS = 180_000;
export const BUILD_TIMEOUT_MS = 480_000;

// Knob: the symbols each deny family names, matched against `nm -C -u` (demangled, undefined) of a layer's objects.
export const SYMBOL_FAMILIES = {
  io: [/^(f?open|fopen64|freopen|fdopen|fread|fwrite|fprintf|vfprintf|printf|vprintf|puts|fputs|fputc|putchar|getchar|fgets|scanf|fscanf|perror|read|write|pread|pwrite|close|unlink|remove|rename|mkdir|rmdir|opendir|readdir|stat|fstat|lstat|access)$/, /^std::(basic_ofstream|basic_ifstream|basic_fstream|basic_filebuf|filesystem::)/, /^std::(cout|cerr|clog|cin|wcout|wcerr|wclog|wcin)$/],
  clock: [/^(time|clock|clock_gettime|gettimeofday|localtime|localtime_r|gmtime|gmtime_r|mktime|timespec_get|ftime)$/, /^std::chrono::(_V2::)?(system_clock|steady_clock|high_resolution_clock|file_clock|utc_clock|tai_clock|gps_clock)::now\b/, /^std::chrono::(current_zone|get_tzdb|tzdb)/],
  env: [/^(getenv|secure_getenv|setenv|unsetenv|putenv|clearenv|environ)$/],
  process: [/^(system|popen|pclose|fork|vfork|execl|execle|execlp|execv|execve|execvp|execvpe|posix_spawnp?|exit|_exit|_Exit|quick_exit|atexit|kill|raise|wait|waitpid)$/],
  thread: [/^(pthread_create|pthread_detach|pthread_join|sleep|usleep|nanosleep|clock_nanosleep|sched_yield)$/, /^std::(thread|jthread|this_thread)::/],
  random: [/^(rand|srand|random|srandom|drand48|lrand48|mrand48|rand_r|arc4random|getrandom|getentropy)$/, /^std::random_device::/],
  net: [/^(socket|connect|bind|listen|accept4?|send|sendto|sendmsg|recv|recvfrom|recvmsg|getaddrinfo|gethostbyname|getnameinfo|inet_pton|inet_ntop|shutdown|setsockopt|getsockopt)$/],
  dynamic: [/^(dlopen|dlsym|dlclose|syscall|mmap|munmap|mprotect|ptrace)$/],
};

// A preset's build tree, repo-relative.
export const buildDir = (preset) => `${BUILD_ROOT}/${preset}`;

// What CMakePresets.json says a preset's binaryDir is, following `inherits`; undefined when unset.
const binaryDirOf = (presets, name, seen = new Set()) => {
  const preset = presets.find((candidate) => candidate.name === name);
  if (preset === undefined || seen.has(name)) return undefined;
  seen.add(name);
  if (typeof preset.binaryDir === "string") return preset.binaryDir;
  for (const parent of [preset.inherits ?? []].flat()) {
    const found = binaryDirOf(presets, parent, seen);
    if (found !== undefined) return found;
  }
  return undefined;
};

// CMakePresets.json's own rules: each pack preset exists and builds where the checks look.
export const checkPresets = (root) => {
  const path = join(root, "CMakePresets.json");
  if (!existsSync(path)) return ["CMakePresets.json is missing: the pack builds its trees through presets (cpp.mdc → Build)."];
  let presets;
  try {
    presets = JSON.parse(readFileSync(path, "utf8")).configurePresets ?? [];
  } catch (error) {
    return [`CMakePresets.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const problems = [];
  for (const name of Object.keys(PRESETS)) {
    if (!presets.some((preset) => preset.name === name)) problems.push(`CMakePresets.json has no configure preset '${name}' (stacks/cpp/evaluated.mjs PRESETS).`);
    else if (binaryDirOf(presets, name) !== `\${sourceDir}/${BUILD_ROOT}/\${presetName}`) problems.push(`CMakePresets.json: preset '${name}' must build in \${sourceDir}/${BUILD_ROOT}/\${presetName}, where the checks read it.`);
  }
  return problems;
};

// Configures one preset with the File API queries in place; resolves run()'s result. `extraArgs` is for gates (a cached GoogleTest).
export const configure = (root, preset, { extraArgs = [], onOutput } = {}) => {
  const query = join(root, buildDir(preset), ".cmake/api/v1/query");
  mkdirSync(query, { recursive: true });
  for (const kind of ["codemodel-v2", "toolchains-v1"]) writeFileSync(join(query, kind), "");
  return run("cmake", ["--preset", preset, ...extraArgs], { cwd: root, timeoutMs: limit(CONFIGURE_TIMEOUT_MS), onOutput });
};

// Builds one preset's tree (or `targets` in it); resolves run()'s result.
export const build = (root, preset, { targets = [], onOutput } = {}) =>
  run("cmake", ["--build", buildDir(preset), ...targets.flatMap((target) => ["--target", target])], { cwd: root, timeoutMs: limit(BUILD_TIMEOUT_MS), onOutput });

// The newest File API reply in a tree: { targets: [target json], compilerIds: { CXX: "Clang" } }, or undefined when there is none.
export const readModel = (root, preset) => {
  const reply = join(root, buildDir(preset), ".cmake/api/v1/reply");
  if (!existsSync(reply)) return undefined;
  const index = readdirSync(reply).filter((name) => name.startsWith("index-")).toSorted().at(-1);
  if (index === undefined) return undefined;
  const read = (file) => JSON.parse(readFileSync(join(reply, file), "utf8"));
  const objects = read(index).objects ?? [];
  const codemodel = objects.find((object) => object.kind === "codemodel");
  const toolchains = objects.find((object) => object.kind === "toolchains");
  if (codemodel === undefined) return undefined;
  const model = read(codemodel.jsonFile);
  const configuration = model.configurations?.[0] ?? { targets: [] };
  const targets = configuration.targets.map((target) => read(target.jsonFile));
  const compilerIds = Object.fromEntries((toolchains === undefined ? [] : read(toolchains.jsonFile).toolchains ?? []).map((toolchain) => [toolchain.language, toolchain.compiler?.id ?? ""]));
  return { targets, compilerIds };
};

// Command-line tokens of fragments (CMAKE_CXX_FLAGS arrives as one fragment, so it is split on whitespace).
const tokens = (fragments) => fragments.flatMap((fragment) => fragment.fragment.split(/\s+/)).filter(Boolean);

// The sanitizers `flags` leave on, in command-line order (-fno-sanitize= takes away, `all` included).
export const sanitizersOf = (flags) => {
  const on = new Set();
  for (const flag of flags) {
    const add = /^-fsanitize=(.+)$/.exec(flag);
    const remove = /^-fno-sanitize=(.+)$/.exec(flag);
    for (const name of add?.[1].split(",") ?? []) on.add(name);
    for (const name of remove?.[1].split(",") ?? []) {
      if (name === "all") on.clear();
      else on.delete(name);
    }
  }
  return on;
};

// What is wrong with one compile's flags for `preset`; `where` names the target.
export const flagProblems = (flags, preset, where) => {
  const problems = [];
  const spec = PRESETS[preset];
  for (const required of REQUIRED_WARNINGS) if (!flags.includes(required)) problems.push(`${where} compiles without ${required} (stacks/cpp/evaluated.mjs REQUIRED_WARNINGS; CMakeLists.txt CPP_WARNINGS).`);
  for (const flag of flags) {
    if (flag === "-w" || flag === "--no-warnings" || flag.startsWith("-Wno-") || flag === "-fpermissive") problems.push(`${where} compiles with ${flag}, which switches warnings off; fix the code instead.`);
    // A system include directory's headers compile with warnings off, so first-party ones may never be marked so (-isystem-after included).
    if (flag.startsWith("-isystem") || flag.startsWith("--system-header-prefix") || flag.startsWith("-iwithprefix")) problems.push(`${where} compiles with ${flag}, which marks headers as system ones, so their warnings go quiet; use target_include_directories without SYSTEM.`);
    if (flag.startsWith("-fsanitize-recover=")) problems.push(`${where} compiles with ${flag}: a sanitizer report must stop the test, not scroll past.`);
    if (/^-fsanitize-(ignorelist|blacklist)=/.test(flag)) problems.push(`${where} compiles with ${flag}: an ignore list switches the sanitizer off for what it names.`);
    if (flag.startsWith("-std=gnu")) problems.push(`${where} compiles as ${flag.slice(5)}: GNU extensions are off (CMAKE_CXX_EXTENSIONS OFF), so the code builds the same on clang and gcc.`);
  }
  const on = sanitizersOf(flags);
  for (const name of spec.sanitize) if (!on.has(name)) problems.push(`${where} compiles without -fsanitize=${name} in the ${preset} tree (CMakePresets.json).`);
  if (spec.noRecover && !flags.includes("-fno-sanitize-recover=all")) problems.push(`${where} compiles without -fno-sanitize-recover=all in the ${preset} tree: an UndefinedBehaviorSanitizer report would print and pass.`);
  return problems;
};

// First-party: a target that compiles a file of ours (under the repo, outside the build trees).
const isOurs = (target) => (target.sources ?? []).some((source) => !source.path.startsWith(`${BUILD_ROOT}/`) && !source.path.startsWith("/"));

// The layers `start` links, directly or further on, each with the path to it (start first).
const layersThrough = (start, byId, names) => {
  const reached = new Map();
  const queue = [[start, [start.name]]];
  while (queue.length > 0) {
    const [target, path] = queue.shift();
    for (const dependency of target.dependencies ?? []) {
      const next = byId.get(dependency.id);
      if (next === undefined || !names.includes(next.name) || reached.has(next.name) || next.name === start.name) continue;
      reached.set(next.name, [...path, next.name]);
      queue.push([next, [...path, next.name]]);
    }
  }
  return reached;
};

// Every finding the configured model of `preset` holds (File API only; no build needed).
export const checkConfigured = (root, preset, model) => {
  const { map, problems: mapProblems } = readLayerMap(root);
  if (map === undefined) return mapProblems;
  const problems = [];
  const names = Object.keys(map.layers);
  const testsDir = map.tests;
  const spec = PRESETS[preset];
  if (model.compilerIds.CXX !== spec.compiler) problems.push(`the ${preset} tree compiles with ${model.compilerIds.CXX || "an unknown compiler"}, not ${spec.compiler} (CMakePresets.json; stacks/cpp/evaluated.mjs PRESETS).`);
  const byId = new Map(model.targets.map((target) => [target.id, target]));
  const testTargets = new Set();
  for (const target of model.targets.filter(isOurs)) {
    const where = `target '${target.name}' (${preset})`;
    const row = map.layers[target.name];
    const sources = (target.sources ?? []).map((source) => source.path);
    if (row === undefined) {
      // Not a layer: only an executable built wholly from the tests directory may stand outside the map.
      if (target.type === "EXECUTABLE" && sources.every((path) => path.startsWith(`${testsDir}/`))) testTargets.add(target.name);
      else problems.push(`${where} has no row in ${LAYER_MAP}: give it one, or build it from ${testsDir}/ as a test.`);
    } else {
      for (const path of sources) if (!path.startsWith(`${SOURCE_ROOT}/${target.name}/`)) problems.push(`${where} compiles ${path}, outside ${SOURCE_ROOT}/${target.name}/.`);
      for (const dependency of target.dependencies ?? []) {
        const other = byId.get(dependency.id);
        if (other === undefined || other.type === "UTILITY") continue;
        if (names.includes(other.name)) {
          if (row.may.includes(other.name)) continue;
          problems.push(`${where} links '${other.name}', which its row doesn't allow (may: ${row.may.join(", ") || "nothing"}).`);
          // A link cycle (an inner layer linking an outer one) reaches the File API as a chain:
          // `domain → adapters` shows as `domain → usecases → adapters`. So follow a refused link,
          // and name each further layer it brings in that the row doesn't allow either.
          for (const [reached, path] of layersThrough(other, byId, names)) {
            if (reached !== target.name && !row.may.includes(reached)) problems.push(`${where} links '${reached}' (through ${path.slice(0, -1).join(" → ")}), which its row doesn't allow (may: ${row.may.join(", ") || "nothing"}).`);
          }
        } else if (!row.anyLibrary || isOurs(other)) {
          problems.push(`${where} links '${other.name}', which is no layer${row.anyLibrary ? "" : `; only a row with "anyLibrary" may link third-party code`}.`);
        }
      }
    }
    for (const group of target.compileGroups ?? []) {
      // The flag and sanitizer checks read C++ compiles; a C (or assembly) file in a first-party target would escape every one.
      if (group.language !== "CXX") {
        const files = (group.sourceIndexes ?? []).map((index) => target.sources?.[index]?.path).filter(Boolean);
        problems.push(`${where} compiles ${group.language} (${files.join(", ") || "a source"}): the pack checks C++ compiles only, so a first-party file is C++; name it .cpp.`);
        continue;
      }
      problems.push(...flagProblems(tokens(group.compileCommandFragments ?? []), preset, where));
      const standard = Number(group.languageStandard?.standard ?? 0);
      if (standard < MIN_STANDARD) problems.push(`${where} compiles as C++${String(group.languageStandard?.standard ?? "?")}, below C++${MIN_STANDARD} (CMakeLists.txt CMAKE_CXX_STANDARD).`);
      for (const include of group.includes ?? []) {
        const path = repoPath(root, include.path);
        const outside = path.startsWith("..") || path.startsWith("/") || path.startsWith(`${BUILD_ROOT}/`);
        // A SYSTEM include directory's headers compile with warnings off: first-party ones never are.
        if (include.isSystem === true && !outside) problems.push(`${where} has ${include.path} as a SYSTEM include directory, so its headers' warnings go quiet; drop SYSTEM from target_include_directories.`);
        if (row !== undefined && (outside ? !row.anyLibrary : !mayReach(path, target.name, row))) problems.push(`${where} has ${include.path} on its include path, which its row doesn't reach.`);
      }
    }
    if (target.type === "EXECUTABLE") {
      const linkFlags = tokens((target.link?.commandFragments ?? []).filter((fragment) => fragment.role === "flags"));
      const on = sanitizersOf(linkFlags);
      for (const name of spec.sanitize) if (!on.has(name)) problems.push(`${where} links without -fsanitize=${name} (CMakePresets.json CMAKE_EXE_LINKER_FLAGS).`);
    }
  }
  for (const name of names) if (!model.targets.some((target) => target.name === name)) problems.push(`${LAYER_MAP}: row '${name}' is not a CMake target in the ${preset} tree.`);
  if (testTargets.size === 0) problems.push(`the ${preset} tree has no test executable built from ${testsDir}/.`);
  return problems;
};

// Parses `ninja -t deps`: object path (build-relative) → absolute dependency paths.
export const parseDeps = (text) => {
  const deps = new Map();
  let current;
  for (const line of text.split("\n")) {
    const object = /^(\S.*?): #deps/.exec(line);
    if (object !== null) {
      current = [];
      deps.set(object[1], current);
    } else if (current !== undefined && line.startsWith("    ")) {
      current.push(line.trim());
    }
  }
  return deps;
};

// Findings in what each layer's objects included, read from a built tree's `ninja -t deps`.
export const checkIncludes = async (root, preset, model) => {
  const { map } = readLayerMap(root);
  if (map === undefined) return [];
  const result = await run("ninja", ["-C", buildDir(preset), "-t", "deps"], { cwd: root, timeoutMs: limit(60_000) });
  const why = failure("ninja -t deps", result, 60_000, "stacks/cpp/evaluated.mjs");
  if (why !== "") return [`${why}: the include graph was not checked.`];
  const deps = parseDeps(result.stdout);
  const problems = [];
  for (const [layer, row] of Object.entries(map.layers)) {
    const target = model.targets.find((candidate) => candidate.name === layer);
    if (target === undefined) continue;
    for (const source of target.sources ?? []) {
      const object = `CMakeFiles/${layer}.dir/${source.path}.o`;
      const included = deps.get(object);
      if (included === undefined) {
        problems.push(`${source.path}: no include record in the ${preset} tree (build it first), so its includes were not checked.`);
        continue;
      }
      for (const header of included) {
        const path = repoPath(root, header);
        if (path.startsWith("..") || path.startsWith("/")) continue;
        if (path.startsWith(`${BUILD_ROOT}/`) ? !row.anyLibrary : !mayReach(path, layer, row)) {
          const owner = layerOfPath(path, Object.keys(map.layers));
          problems.push(`${source.path} includes ${path}${owner === undefined ? "" : ` (layer '${owner}')`}, which layer '${layer}' may not reach (${LAYER_MAP} may: ${row.may.join(", ") || "nothing"}).`);
        }
      }
    }
  }
  return problems;
};

// Parses `nm -C -u` of an archive: [{ member, symbol }].
export const parseUndefined = (text) => {
  const found = [];
  let member = "";
  for (const line of text.split("\n")) {
    const header = /^(\S+\.o):$/.exec(line.trim());
    if (header !== null) member = header[1];
    const undefinedSymbol = /^\s*U\s+(.+)$/.exec(line);
    if (undefinedSymbol !== null) found.push({ member, symbol: undefinedSymbol[1].trim() });
  }
  return found;
};

// The deny family a symbol belongs to, or undefined.
export const familyOf = (symbol) => Object.entries(SYMBOL_FAMILIES).find(([, patterns]) => patterns.some((pattern) => pattern.test(symbol)))?.[0];

// Findings in what each layer's objects call, read with nm from a built tree.
export const checkSymbols = async (root, preset, model) => {
  const { map } = readLayerMap(root);
  if (map === undefined) return [];
  const problems = [];
  for (const [layer, row] of Object.entries(map.layers)) {
    if (row.deny.length === 0) continue;
    const target = model.targets.find((candidate) => candidate.name === layer);
    const artifact = target?.artifacts?.[0]?.path;
    if (artifact === undefined) continue;
    const archive = join(buildDir(preset), artifact);
    if (!existsSync(join(root, archive))) {
      problems.push(`${archive} is not built, so layer '${layer}''s calls were not checked.`);
      continue;
    }
    const result = await run("nm", ["-C", "-u", archive], { cwd: root, timeoutMs: limit(60_000) });
    const why = failure("nm", result, 60_000, "stacks/cpp/evaluated.mjs");
    if (why !== "") {
      problems.push(`${why}: layer '${layer}''s calls were not checked.`);
      continue;
    }
    for (const { member, symbol } of parseUndefined(result.stdout)) {
      const family = familyOf(symbol);
      if (family !== undefined && row.deny.includes(family)) problems.push(`layer '${layer}' calls ${symbol} (${family}) from ${member}; its row denies ${family}: move it behind a port (docs/ports-and-adapters.md).`);
    }
  }
  return problems;
};
