// The C++ pack's source rules: the layer map's own shape, and what no source may say to switch a gate off.
// In the app: nothing at runtime; `pnpm cpp:lint` (so `pnpm check` and CI) and the edit hook run it. Needs no toolchain.
// Used by: stacks/cpp/run.mjs, stacks/cpp/evaluated.mjs (the map), stacks/cpp/gates.mjs, stacks/cpp/check-edited.mjs; tested by stacks/cpp/sources.test.mjs.
// Uses: cpp-layers.json, cpp/**.
//
// The build can't see these, because each one is a way to say "don't check this" in the source:
// a NOLINT without a check name and a reason, a `#pragma … diagnostic ignored` or `system_header`,
// a sanitizer turned off for a function or by default options, `clang-format off` with no reason,
// a disabled or skipped GoogleTest test, a FaultKind no test plays, a nested .clang-tidy that
// doesn't inherit the root's, and an #include past the file's own layer (judged by the file's
// layer, not the including unit's). The layer map is read here too, so a row
// that matches nothing, a directory with no row, or a row loosened below the floor fails before
// anything builds. stacks/cpp/gates.mjs plants a violation of each rule and fails unless it is reported.
//
//   node stacks/cpp/sources.mjs      exit 0 clean, 1 on any finding (the same findings `pnpm cpp:lint` prints)

// Node builtins only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";

// Knob: where the layers live; each is cpp/<layer>/ (include/ for headers, src/ for sources).
export const SOURCE_ROOT = "cpp";

// Knob: the layer map's file.
export const LAYER_MAP = "cpp-layers.json";

// Knob: C++ file extensions every rule reads.
export const CPP_EXTENSIONS = [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h", ".ipp"];

// Knob: the symbol families a layer row may deny (stacks/cpp/evaluated.mjs SYMBOL_FAMILIES spells each out).
export const FAMILIES = ["io", "clock", "env", "process", "thread", "random", "net", "dynamic"];

// Knob: the floor. The innermost layer (the one whose row allows no other layer) denies every
// family; any other layer some row depends on denies all but `thread` (a use-case may lock).
// A row can deny more; going below this fails, so a loosened row is a finding, not a quiet pass.
export const INNERMOST_FLOOR = FAMILIES;
export const INNER_FLOOR = FAMILIES.filter((family) => family !== "thread");

// Knob: clang-tidy checks that must be on for every first-party directory, whatever .clang-tidy
// (root or nested) says. run.mjs reads each directory's evaluated list (`clang-tidy --list-checks`);
// gates.mjs plants a violation of each one.
export const REQUIRED_TIDY_CHECKS = [
  "bugprone-use-after-move",
  "bugprone-unchecked-optional-access",
  "concurrency-mt-unsafe",
  "cppcoreguidelines-no-malloc",
  "cppcoreguidelines-pro-type-reinterpret-cast",
  "google-explicit-constructor",
  "modernize-use-nullptr",
  "performance-unnecessary-value-param",
];

// Every file under `dir` that `keep(name)` accepts (repo-relative paths, sorted).
const filesUnder = (root, dir, keep) => {
  const found = [];
  const walk = (relativeDir) => {
    const absolute = join(root, relativeDir);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute).toSorted()) {
      const path = `${relativeDir}/${entry}`;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (keep(entry)) found.push(path);
    }
  };
  walk(dir);
  return found;
};

// Every C++ file under `dir` (repo-relative paths, sorted).
export const cppFiles = (root, dir = SOURCE_ROOT) => filesUnder(root, dir, (entry) => CPP_EXTENSIONS.some((extension) => entry.endsWith(extension)));

// Every nested .clang-tidy under the source root (the root's own is the project's floor config).
export const nestedTidyConfigs = (root) => filesUnder(root, SOURCE_ROOT, (entry) => entry === ".clang-tidy");

// The layer a repo-relative path belongs to (cpp/<layer>/…), or undefined.
export const layerOfPath = (path, names) => {
  const [top, layer] = path.split("/");
  return top === SOURCE_ROOT && names.includes(layer) ? layer : undefined;
};

// True when a repo-relative path is one a layer may include from: its own directory, or an allowed layer's include/.
// A directory (no trailing slash) or a file, either way.
export const mayReach = (path, layer, row) => [`${SOURCE_ROOT}/${layer}/`, ...row.may.map((other) => `${SOURCE_ROOT}/${other}/include/`)].some((prefix) => `${path}/`.startsWith(prefix));

// Source with comments and string/char literals blanked to spaces (same length, newlines kept), so
// prose never matches a code rule. `keep: "comments"` blanks only the code instead, for the rules
// that live in comments (NOLINT, clang-format off).
export const blank = (source, { keep = "code" } = {}) => {
  let code = "";
  let comments = "";
  let i = 0;
  // Appends source[from, to) to one side and spaces (newlines kept) to the other.
  const take = (from, to, side) => {
    const text = source.slice(from, to);
    const spaces = text.replace(/[^\n]/g, " ");
    code += side === "code" ? text : spaces;
    comments += side === "comment" ? text : spaces;
  };
  while (i < source.length) {
    const start = i;
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i += 1;
      take(start, i, "comment");
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      take(start, i, "comment");
    } else if (/R"([^(\s]*)\(/.test(source.slice(i, i + 20)) && (i === 0 || !/\w/.test(source[i - 1]))) {
      // A raw string: R"delim( … )delim".
      const delimiter = /R"([^(\s]*)\(/.exec(source.slice(i, i + 20))?.[1] ?? "";
      const end = source.indexOf(`)${delimiter}"`, i);
      i = end === -1 ? source.length : end + delimiter.length + 2;
      take(start, i, "literal");
    } else if (source[i] === '"' || (source[i] === "'" && !/[0-9a-fA-F]/.test(source[i - 1] ?? ""))) {
      // A string or char literal (a ' between hex digits is a digit separator, 1'000).
      const quote = source[i];
      i += 1;
      while (i < source.length && source[i] !== quote && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, source.length);
      take(start, i, "literal");
    } else {
      take(i, i + 1, "code");
      i += 1;
    }
  }
  return keep === "comments" ? comments : code;
};

// 1-based line of `offset` in `text`.
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

// The layer map, or the findings that stop it being read.
export const readLayerMap = (root) => {
  const path = join(root, LAYER_MAP);
  if (!existsSync(path)) return { problems: [`${LAYER_MAP} is missing: there is no layer map to check against (cpp.mdc → Layers).`] };
  let map;
  try {
    map = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { problems: [`${LAYER_MAP} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (typeof map !== "object" || map === null || typeof map.layers !== "object" || map.layers === null || Object.keys(map.layers).length === 0) {
    return { problems: [`${LAYER_MAP} has no layers: a map with nothing in it checks nothing.`] };
  }
  return { map, problems: [] };
};

// The layer map's rules: every row is a directory and every directory a row, `may` names real
// layers, `deny` names real families and holds the floor.
export const checkLayerMap = (root) => {
  const { map, problems } = readLayerMap(root);
  if (map === undefined) return problems;
  const names = Object.keys(map.layers);
  const testsDir = typeof map.tests === "string" ? map.tests : "";
  if (testsDir === "" || !existsSync(join(root, testsDir))) problems.push(`${LAYER_MAP}: "tests" must name the tests directory (it is ${JSON.stringify(map.tests)}, which doesn't exist).`);
  // Directories under cpp/ that are layers or the tests.
  const dirs = existsSync(join(root, SOURCE_ROOT)) ? readdirSync(join(root, SOURCE_ROOT)).filter((entry) => statSync(join(root, SOURCE_ROOT, entry)).isDirectory()) : [];
  for (const dir of dirs) {
    if (!names.includes(dir) && `${SOURCE_ROOT}/${dir}` !== testsDir) problems.push(`${SOURCE_ROOT}/${dir}/ has no row in ${LAYER_MAP}: add one (or move the code into a layer).`);
  }
  // Layers some row depends on: everything but the outermost.
  const dependedOn = new Set(names.flatMap((name) => map.layers[name]?.may ?? []));
  for (const name of names) {
    const row = map.layers[name];
    if (typeof row !== "object" || row === null || !Array.isArray(row.may) || !Array.isArray(row.deny)) {
      problems.push(`${LAYER_MAP}: row '${name}' needs "may" and "deny" arrays.`);
      continue;
    }
    if (cppFiles(root, `${SOURCE_ROOT}/${name}`).length === 0) problems.push(`${LAYER_MAP}: row '${name}' matches no C++ files under ${SOURCE_ROOT}/${name}/.`);
    for (const other of row.may) {
      if (other === name) problems.push(`${LAYER_MAP}: row '${name}' lists itself in "may".`);
      else if (!names.includes(other)) problems.push(`${LAYER_MAP}: row '${name}' may use '${other}', which is no layer.`);
    }
    for (const family of row.deny) {
      if (!FAMILIES.includes(family)) problems.push(`${LAYER_MAP}: row '${name}' denies '${family}', which is no symbol family (one of ${FAMILIES.join(", ")}).`);
    }
    // The floor: what this row must deny however it is edited.
    const floor = row.may.length === 0 ? INNERMOST_FLOOR : dependedOn.has(name) ? INNER_FLOOR : [];
    const missing = floor.filter((family) => !row.deny.includes(family));
    if (missing.length > 0) problems.push(`${LAYER_MAP}: row '${name}' must deny ${missing.join(", ")} (${row.may.length === 0 ? "the innermost layer denies every family" : "a layer others depend on denies all but thread"}; cpp.mdc → Layers).`);
    if (row.anyLibrary === true && dependedOn.has(name)) problems.push(`${LAYER_MAP}: row '${name}' sets anyLibrary, but other layers depend on it; only the outermost layer may link third-party code.`);
  }
  // "tidyOff": { "<dir>": [check, …] }, what a nested .clang-tidy may turn off there (run.mjs tidyFloor); never a floor check.
  const tidyOff = map.tidyOff ?? {};
  if (typeof tidyOff !== "object" || tidyOff === null || Array.isArray(tidyOff)) problems.push(`${LAYER_MAP}: "tidyOff" must map a directory to the checks a nested .clang-tidy may turn off there.`);
  else {
    for (const [dir, checks] of Object.entries(tidyOff)) {
      if (!Array.isArray(checks) || !checks.every((check) => typeof check === "string")) problems.push(`${LAYER_MAP}: tidyOff["${dir}"] must be a list of check names.`);
      else for (const check of checks.filter((candidate) => REQUIRED_TIDY_CHECKS.includes(candidate))) problems.push(`${LAYER_MAP}: tidyOff["${dir}"] lists ${check}, which is on the floor (REQUIRED_TIDY_CHECKS) and stays on everywhere.`);
    }
  }
  return problems;
};

// A nested .clang-tidy narrows the root's checks; one that doesn't inherit replaces them (run.mjs
// tidyFloor then names each check it lost). Findings for every nested config under the source root.
export const checkNestedTidy = (root) =>
  nestedTidyConfigs(root)
    .filter((path) => !/^InheritParentConfig:\s*(true|yes|on)\s*$/im.test(readFileSync(join(root, path), "utf8")))
    .map((path) => `${path}: a nested .clang-tidy must say \`InheritParentConfig: true\`, so it narrows the root's checks instead of replacing them.`);

// Where `spelled` (an #include's path) resolves from `file` in `layer`: the including file's
// directory for a quoted include, then the include/ dirs `layer` may reach, then any of the layer's
// own directories (a PRIVATE include dir such as cpp/<layer>/src, which the build may add), and only
// then every other layer's include/ and the tests directory. So a header found where the layer may
// look wins (no finding), and one found only out of reach is the finding. Undefined when it is no
// file of ours (a system or third-party header). `ownFiles` lists the layer's own C++ files.
const resolveInclude = (root, map, file, layer, spelled, quoted, ownFiles) => {
  const includeDirs = [...Object.keys(map.layers).map((name) => `${SOURCE_ROOT}/${name}/include`), ...(typeof map.tests === "string" ? [map.tests] : [])];
  const reachable = includeDirs.filter((dir) => mayReach(dir, layer, map.layers[layer]));
  const candidates = [...(quoted ? [posix.dirname(file)] : []), ...reachable].map((dir) => posix.normalize(`${dir}/${spelled}`));
  const found = candidates.find((path) => !path.startsWith("..") && existsSync(join(root, path)));
  if (found !== undefined) return found;
  const tail = `/${posix.normalize(spelled)}`;
  const own = tail.includes("/../") ? undefined : ownFiles().find((path) => path.endsWith(tail));
  if (own !== undefined) return own;
  return includeDirs
    .filter((dir) => !reachable.includes(dir))
    .map((dir) => posix.normalize(`${dir}/${spelled}`))
    .find((path) => !path.startsWith("..") && existsSync(join(root, path)));
};

// A layer file's #includes, judged by the file's own layer (not by whichever unit includes it, as
// ninja's deps are): an edge from a domain header to an adapters header is found even while only
// adapters includes that domain header.
const includeReach = (root, file, code, source) => {
  const { map } = readLayerMap(root);
  const names = map === undefined ? [] : Object.keys(map.layers);
  const layer = layerOfPath(file, names);
  if (map === undefined || layer === undefined) return [];
  const row = map.layers[layer];
  if (!Array.isArray(row?.may)) return [];
  const findings = [];
  const rawLines = source.split("\n");
  // The layer's own files, listed once and only if some include isn't found where the layer may look.
  let ownList;
  const ownFiles = () => (ownList ??= cppFiles(root, `${SOURCE_ROOT}/${layer}`));
  for (const [index, line] of code.split("\n").entries()) {
    if (!/^\s*#\s*include\b/.test(line)) continue;
    const spelled = /#\s*include\s*([<"])([^>"]+)[>"]/.exec(rawLines[index] ?? "");
    if (spelled === null) continue;
    const found = resolveInclude(root, map, file, layer, spelled[2], spelled[1] === '"', ownFiles);
    if (found === undefined || mayReach(found, layer, row)) continue;
    const owner = layerOfPath(found, names);
    findings.push(`${file}:${index + 1}: includes ${spelled[2]} (${found}${owner === undefined ? "" : `, layer '${owner}'`}), which layer '${layer}' may not reach (${LAYER_MAP} may: ${row.may.join(", ") || "nothing"}). A file is judged by its own layer, whoever includes it.`);
  }
  return findings;
};

// A NOLINT that names its checks and gives a reason: NOLINT(check[,check]): why. Every group
// always takes part (empty when absent), so each reads as a string.
const NOLINT = /\bNOLINT(NEXTLINE|BEGIN|END|)\b(\([^)]*\)|)(\s*:\s*\S|)/g;

// Each rule over code (comments and strings blanked): the pattern, and what to say.
const CODE_RULES = [
  { pattern: /#\s*pragma\s+(clang|GCC)\s+diagnostic\s+(ignored|warning)\b/g, say: "`#pragma … diagnostic ignored` switches a warning off; fix the code (or, in a vendor header's include, mark the include SYSTEM in CMake)." },
  { pattern: /#\s*pragma\s+warning\b/g, say: "`#pragma warning` switches a warning off; fix the code." },
  { pattern: /\b_Pragma\s*\(/g, say: "`_Pragma(…)` is a #pragma by another name; the diagnostic rules see through it." },
  { pattern: /#\s*pragma\s+(clang|GCC)\s+system_header\b/g, say: "`#pragma … system_header` makes the compiler treat a first-party header as a system one, so its warnings go quiet; fix the code." },
  // `__no_sanitize__` and friends: `\b` alone fails after a leading `__`.
  { pattern: /(?:\b|__)no_sanitize(_address|_thread|_undefined|_memory)?(?:__)?\b|\bdisable_sanitizer_instrumentation\b/g, say: "a `no_sanitize` attribute (or `disable_sanitizer_instrumentation`) switches a sanitizer off for that code; fix what it reports." },
  { pattern: /\b__(asan|ubsan|tsan|lsan|msan)_default_options\b/g, say: "sanitizer default options in the source can switch reports off; options live in stacks/cpp/run.mjs (SANITIZER_ENV)." },
  { pattern: /\b__lsan_(disable|ignore_object)\b/g, say: "LeakSanitizer switched off in the source; fix the leak." },
];

// Rules that hold only in the tests directory.
const TEST_RULES = [
  { pattern: /\bDISABLED_\w+/g, say: "a DISABLED_ test never runs; delete it or fix it." },
  { pattern: /\bGTEST_SKIP\b/g, say: "GTEST_SKIP turns a test into a pass that checked nothing; a test that can't run here is a runbook scenario or a Human check (testing.mdc)." },
];

// The GoogleTest tests in `text` (comments and strings blanked): { macro, suite, name, line }.
const TEST_MACRO = /\b(TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P)\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g;
const testsIn = (code) => [...code.matchAll(TEST_MACRO)].map((match) => ({ macro: match[1], suite: match[2], name: match[3], line: lineOf(code, match.index) }));

// Every test in the source under the tests directory: { file, line, macro, suite, name }. A test in
// `#if 0` is still here, which is the point: run.mjs fails one that didn't run.
export const testsInSource = (root) => {
  const testsDir = readLayerMap(root).map?.tests ?? `${SOURCE_ROOT}/tests`;
  return cppFiles(root, testsDir).flatMap((file) => testsIn(blank(readFileSync(join(root, file), "utf8"))).map((test) => ({ file, ...test })));
};

// The fault catalogue's kinds, and the file that holds it (an `enum class FaultKind` under the tests), or undefined.
export const faultKinds = (root) => {
  const testsDir = readLayerMap(root).map?.tests ?? `${SOURCE_ROOT}/tests`;
  for (const file of cppFiles(root, testsDir)) {
    const code = blank(readFileSync(join(root, file), "utf8"));
    const found = /\benum\s+class\s+FaultKind\b[^{]*\{([^}]*)\}/.exec(code);
    if (found !== null) return { file, kinds: found[1].split(",").map((kind) => kind.replace(/=.*/s, "").trim()).filter(Boolean) };
  }
  return undefined;
};

// Findings for one file: `file` is repo-relative; `inTests` turns the test-only rules on.
export const checkFile = (root, file, { inTests = file.startsWith(`${SOURCE_ROOT}/tests/`) } = {}) => {
  const source = readFileSync(join(root, file), "utf8");
  const code = blank(source);
  const comments = blank(source, { keep: "comments" });
  const findings = [];
  for (const rule of [...CODE_RULES, ...(inTests ? TEST_RULES : [])]) {
    for (const match of code.matchAll(rule.pattern)) findings.push(`${file}:${lineOf(code, match.index)}: ${rule.say}`);
  }
  for (const match of comments.matchAll(NOLINT)) {
    const [, kind, parens, reason] = match;
    // NOLINTEND closes a NOLINTBEGIN; its checks must match, which clang-tidy itself enforces.
    if (kind === "END") continue;
    const checks = parens.slice(1, -1);
    const where = `${file}:${lineOf(comments, match.index)}`;
    if (checks.trim() === "") findings.push(`${where}: NOLINT${kind} must name its checks: \`// NOLINT${kind}(<check>): <why>\` (a bare one silences every check).`);
    else if (checks.includes("*")) findings.push(`${where}: NOLINT${kind}(${checks}) silences a whole group; name each check.`);
    else if (reason === "") findings.push(`${where}: NOLINT${kind}(${checks}) needs a reason after it: \`// NOLINT${kind}(${checks}): <why>\`.`);
  }
  for (const match of comments.matchAll(/clang-format\s+off\b(\s*:\s*\S|)/g)) {
    if (match[1] === "") findings.push(`${file}:${lineOf(comments, match.index)}: \`// clang-format off\` needs a reason: \`// clang-format off: <why>\`.`);
  }
  findings.push(...includeReach(root, file, code, source));
  return findings;
};

// Every source rule over the whole tree: the layer map, nested .clang-tidy files, each file, and the fault catalogue.
export const checkSources = (root) => {
  const findings = [...checkLayerMap(root), ...checkNestedTidy(root)];
  for (const file of cppFiles(root)) findings.push(...checkFile(root, file));
  const faults = faultKinds(root);
  if (faults !== undefined) {
    const names = testsInSource(root).map((test) => test.name);
    for (const kind of faults.kinds) {
      if (!names.some((name) => name.startsWith(`${kind}_`))) findings.push(`${faults.file}: FaultKind::${kind} has no test: name one \`TEST(…, ${kind}_<what it proves>)\` (testing-cpp.mdc → Fault injection).`);
    }
  }
  return findings;
};

// Repo-relative form of an absolute path, with forward slashes.
export const repoPath = (root, path) => relative(root, path).split("\\").join("/");

// CLI: print the findings, exit 1 on any.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = checkSources(process.cwd());
  if (findings.length > 0) {
    process.stderr.write(`✗ cpp sources:\n${findings.map((line) => `  ${line}`).join("\n")}\n`);
    process.exit(1);
  }
}
