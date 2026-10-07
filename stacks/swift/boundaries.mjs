#!/usr/bin/env node
// The Swift pack's boundary check: each target may import only the modules swift-layers.json allows, and a few rules the compiler can't state.
// In the app: nothing at runtime; `pnpm swift:boundaries` (so `pnpm check`, CI, and the edit hook) runs it. No swift needed.
// Used by: package.json `swift:boundaries`, stacks/swift/check-edited.mjs, stacks/swift/gates.mjs, stacks/swift/manifest.mjs (STRICT), stacks/swift/run.mjs (the @Tests in the source); tested by stacks/swift/boundaries.test.mjs.
// Uses: Package.swift, swift-layers.json, Sources/<Target>/**.swift, Tests/**.swift; docs/decisions/0003-ports-and-adapters.md.
//
// Layers are SwiftPM targets, so the compiler refuses an import a target didn't declare: mostly.
// SwiftPM puts every built module in one directory, so a target can `import` a module it never
// declared if that module happened to build first, and the build is green. So the source is read
// instead, and the rules below hold whatever the build order is. A rule that matches nothing would
// pass silently, so the check also fails on a layer with no directory, a directory with no layer,
// a layer Package.swift doesn't declare, and a Package.swift target that would escape the scan (a
// `path:` outside Sources/<Name>, no layer row, no strict settings, `unsafeFlags`). That reads text;
// stacks/swift/manifest.mjs checks the same targets as evaluated, wherever swift is present.
// `stacks/swift/gates.mjs` plants a violation of each rule on a scratch copy and fails unless this
// reports it.
//
//   node stacks/swift/boundaries.mjs [--root <dir>]     exit 0 clean, 1 on any violation

// Node builtins only.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A source with comments (and, unless `keepStrings`, string literals) blanked to spaces, same
// length and line breaks, so an `import` or `default:` in prose is not a finding and every offset
// and line number still points into the original.
const blank = (source, { keepStrings = false } = {}) => {
  let out = "";
  let i = 0;
  // Spaces for source[from, to), newlines kept.
  const hide = (from, to) => {
    for (let k = from; k < to; k += 1) out += source[k] === "\n" ? "\n" : " ";
  };
  while (i < source.length) {
    const start = i;
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i += 1;
      hide(start, i);
    } else if (two === "/*") {
      // Swift block comments nest.
      let depth = 0;
      do {
        const pair = source.slice(i, i + 2);
        if (pair === "/*") {
          depth += 1;
          i += 2;
        } else if (pair === "*/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      } while (depth > 0 && i < source.length);
      i = Math.min(i, source.length);
      hide(start, i);
    } else if (source[i] === '"') {
      // A string (single or triple quoted), escapes skipped.
      const closer = source.slice(i, i + 3) === '"""' ? '"""' : '"';
      i += closer.length;
      while (i < source.length && source.slice(i, i + closer.length) !== closer) i += source[i] === "\\" ? 2 : 1;
      i = Math.min(i + closer.length, source.length);
      if (keepStrings) out += source.slice(start, i);
      else hide(start, i);
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
};

// Comments and string literals blanked (same length), so prose is never a finding.
export const withoutCommentsAndStrings = (source) => blank(source);

// The index of the bracket that closes the one at `open` (`(` or `[` or `{`), in blanked code; -1 when unbalanced.
const closing = (code, open) => {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let i = open; i < code.length; i += 1) {
    if (code[i] in pairs) stack.push(pairs[code[i]]);
    else if (code[i] === ")" || code[i] === "]" || code[i] === "}") {
      if (stack.pop() !== code[i]) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
};

// 1-based line of offset `index`.
const lineAt = (text, index) => text.slice(0, index).split("\n").length;

// Matches `import X`, `@testable import X`, `internal import X`, `import struct X.Y`, `public import X.Sub` (module = X).
const IMPORT = /^[ \t]*(?:@\w+(?:\([^)]*\))?[ \t]+)*(?:(?:public|package|internal|fileprivate|private)[ \t]+)?import[ \t]+(?:(?:typealias|struct|class|enum|protocol|let|var|func)[ \t]+)?([A-Za-z_]\w*)/gm;

// Modules a source imports, with their line numbers.
export const importsOf = (source) => {
  const clean = withoutCommentsAndStrings(source);
  return [...clean.matchAll(IMPORT)].map((match) => ({ module: match[1], line: lineAt(clean, match.index) }));
};

// System modules a layer row may name besides the layers themselves; add one here when a layer really needs it.
const SYSTEM_MODULES = new Set(["Foundation", "Dispatch", "Synchronization", "Observation", "OSLog", "os", "SwiftUI", "Combine", "CoreData", "CryptoKit"]);

// Knob: the settings array every target must take (`swiftSettings: strict`), and what it must hold.
// Dropping one turns warnings back into warnings, or `any` back into implicit, for the whole package.
export const STRICT = { name: "strict", settings: [".treatAllWarnings(as: .error)", '.enableUpcomingFeature("ExistentialAny")'] };

// Underscored attributes that bind a symbol by its linker name: a call past every import rule.
const LINKER_ATTRIBUTES = /@_(silgen_name|extern)\b/g;

// A `default:` label (not `@unknown default:`): it silences the compiler's missing-case error on an enum we own.
const DEFAULT_LABEL = /^[ \t]*(?<!@unknown[ \t])default[ \t]*:/gm;

// A test trait that switches a test off (`.disabled(...)`, `.enabled(if:)`), however it is spaced.
const OFF_TRAIT = /\.(disabled|enabled)\s*\(/;

// Target kinds in Package.swift. Code kinds are layers (or tests) and must take the strict settings.
const TARGET_CALL = /\.(target|executableTarget|testTarget|macro|plugin|binaryTarget|systemLibrary)\s*\(/g;
const CODE_KINDS = new Set(["target", "executableTarget", "testTarget", "macro"]);

// Every target Package.swift declares: { kind, name, path, strict, line }. A `.target(name:)`
// dependency inside another target's arguments is not a declaration, so nested calls are skipped.
export const packageTargets = (manifest) => {
  const code = blank(manifest);
  const withStrings = blank(manifest, { keepStrings: true });
  const targets = [];
  let end = -1;
  for (const match of code.matchAll(TARGET_CALL)) {
    if (match.index < end) continue;
    const open = match.index + match[0].length - 1;
    end = closing(code, open);
    if (end === -1) break;
    // The arguments at depth 0 only: nested calls and arrays blanked, so their `name:` and `path:` don't count.
    let depth = 0;
    let topCode = "";
    for (let i = open + 1; i < end; i += 1) {
      const char = code[i];
      if ("([{".includes(char)) depth += 1;
      topCode += depth === 0 ? withStrings[i] : char === "\n" ? "\n" : " ";
      if (")]}".includes(char)) depth -= 1;
    }
    targets.push({
      kind: match[1],
      name: /^\s*name:\s*"([^"]*)"/.exec(topCode)?.[1] ?? "",
      path: /\bpath:\s*"([^"]*)"/.exec(topCode)?.[1],
      strict: new RegExp(`\\bswiftSettings:\\s*${STRICT.name}\\b`).test(code.slice(open + 1, end)),
      line: lineAt(code, match.index),
    });
  }
  return targets;
};

// Problems in Package.swift itself: targets the scan can't see or that drop the strict settings, unsafe flags, unpinned or unexplained packages.
const manifestProblems = (manifest, layers, sources) => {
  const problems = [];
  const code = blank(manifest);
  const lines = manifest.split("\n");
  for (const target of packageTargets(manifest)) {
    const where = `Package.swift:${target.line}: target '${target.name}'`;
    const isTest = target.kind === "testTarget";
    if (CODE_KINDS.has(target.kind) && !isTest && !(target.name in layers)) problems.push(`${where} has no row in swift-layers.json: add one, or its imports are unchecked.`);
    const home = isTest ? `Tests/${target.name}` : target.kind === "plugin" ? `Plugins/${target.name}` : `${sources}/${target.name}`;
    if (target.path !== undefined && target.path.replace(/\/+$/, "") !== home) problems.push(`${where} has \`path: "${target.path}"\`: the boundary check reads ${home} only, so move the sources there and drop \`path:\`.`);
    if (CODE_KINDS.has(target.kind) && !target.strict) problems.push(`${where} does not take \`swiftSettings: ${STRICT.name}\`: every target builds with warnings as errors and explicit \`any\`.`);
  }
  // The strict array itself: each setting present (spacing ignored).
  const declared = new RegExp(`\\blet\\s+${STRICT.name}\\b[^=]*=\\s*\\[`).exec(code);
  if (declared === null) problems.push(`Package.swift: no \`let ${STRICT.name}\` settings array: every target takes it (swift.mdc).`);
  else {
    const open = declared.index + declared[0].length - 1;
    const body = blank(manifest, { keepStrings: true }).slice(open, closing(code, open) + 1).replace(/\s+/g, "");
    for (const setting of STRICT.settings) {
      if (!body.includes(setting.replace(/\s+/g, ""))) problems.push(`Package.swift:${lineAt(code, declared.index)}: \`${STRICT.name}\` lacks \`${setting}\` (swift.mdc).`);
    }
  }
  for (const match of code.matchAll(/\bunsafeFlags\b/g)) {
    problems.push(`Package.swift:${lineAt(code, match.index)}: \`unsafeFlags\`: raw compiler flags can turn off any check here (and SwiftPM refuses them in a dependency); use a SwiftSetting.`);
  }
  // Third-party packages, wherever they appear: pinned exactly, and each justified in a comment on the line above.
  for (const match of code.matchAll(/\.package\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const call = blank(manifest, { keepStrings: true }).slice(open, closing(code, open) + 1);
    const line = lineAt(code, match.index);
    if (!/\bexact:/.test(call)) problems.push(`Package.swift:${line}: a package that is not pinned with \`exact:\`: a floating version changes behavior under you.`);
    if (!/^\s*\/\//.test(lines[line - 2] ?? "")) problems.push(`Package.swift:${line}: a package with no comment on the line above saying why it is worth a dependency.`);
  }
  return problems;
};

// Every .swift file under dir, repo-relative paths with forward slashes; [] when dir is missing.
const swiftFiles = (root, dir) =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".swift"))
        .map((entry) => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"))
    : [];

// The test file that declares `enum FaultKind`, and its cases; undefined when there is none.
export const faultKinds = (root) => {
  const file = swiftFiles(root, "Tests").find((path) => /enum FaultKind\b/.test(withoutCommentsAndStrings(readFileSync(join(root, path), "utf8"))));
  if (file === undefined) return undefined;
  const code = withoutCommentsAndStrings(readFileSync(join(root, file), "utf8"));
  const declared = /enum FaultKind\b[^{]*\{/.exec(code);
  if (declared === null) return undefined;
  const open = declared.index + declared[0].length - 1;
  const body = code.slice(open + 1, closing(code, open));
  return { file, kinds: [...body.matchAll(/\bcase\s+([a-z]\w*(?:\s*,\s*[a-z]\w*)*)/g)].flatMap((match) => match[1].split(",").map((name) => name.trim())) };
};

// The Swift `os()` name for a Node platform: the one platform a `#if os(...)` block may be compiled out on.
const SWIFT_OS = { darwin: "macOS", linux: "Linux", win32: "Windows" };

// For each line of blanked code, whether a `#if os(X)` / `#if !os(X)` block (or its `#else`) compiles it out on `platform`.
// Any other condition (`#if false`, `#if DEBUG`, `canImport`, `#elseif`) is not taken as a reason: what it hides must still run.
const platformHidden = (code, platform) => {
  const here = SWIFT_OS[platform];
  const frames = [];
  return code.split("\n").map((line) => {
    const directive = /^\s*#(if|elseif|else|endif)\b(.*)$/.exec(line);
    if (directive !== null) {
      const [, word, rest] = directive;
      if (word === "if") {
        const os = /^\s*(!?)\s*os\(\s*(\w+)\s*\)\s*$/.exec(rest);
        frames.push(os === null ? { known: false } : { known: true, active: (os[2] === here) !== (os[1] === "!") });
      } else if (word === "elseif" && frames.length > 0) frames[frames.length - 1] = { known: false };
      else if (word === "else" && frames.length > 0) {
        const frame = frames[frames.length - 1];
        if (frame.known) frame.active = !frame.active;
      } else if (word === "endif") frames.pop();
      return false;
    }
    return frames.some((frame) => frame.known && !frame.active);
  });
};

// Every Swift Testing @Test under Tests/: `{ file, line, display, func, body, hidden }`, display being the
// @Test("...") name and `hidden` true when a `#if os(...)` compiles it out on `platform`. Read from the
// source text, so a test hidden from the compiler (`#if false`) is still listed, and run.mjs fails
// when the log lacks it.
export const testsInSource = (root, platform = process.platform) => {
  const tests = [];
  for (const file of swiftFiles(root, "Tests")) {
    const raw = readFileSync(join(root, file), "utf8");
    const code = blank(raw);
    const withStrings = blank(raw, { keepStrings: true });
    const hiddenAt = platformHidden(code, platform);
    for (const match of code.matchAll(/@Test\b/g)) {
      const after = match.index + match[0].length;
      const display = /^\s*\(\s*"((?:[^"\\]|\\.)*)"/.exec(withStrings.slice(after))?.[1]?.replace(/\\(.)/g, "$1");
      const func = /\bfunc\s+(\w+)[^{]*\{/.exec(code.slice(after));
      if (func === null) continue;
      const open = after + func.index + func[0].length - 1;
      const line = lineAt(code, match.index);
      tests.push({ file, line, display, func: func[1], body: code.slice(open, closing(code, open) + 1), hidden: hiddenAt[line - 1] });
    }
  }
  return tests;
};

// Each FaultKind case → the Swift Testing @Test functions whose body plays it (`kind: .<case>`).
// An empty Map when the tests declare no FaultKind.
export const faultTestsByKind = (root) => {
  const found = faultKinds(root);
  const byKind = new Map((found?.kinds ?? []).map((kind) => [kind, []]));
  if (found === undefined) return byKind;
  for (const test of testsInSource(root)) {
    for (const [, kind] of test.body.matchAll(/\bkind:\s*\.(\w+)/g)) byKind.get(kind)?.push(test);
  }
  return byKind;
};

// Violations of the layer map as readable lines, each ending in the fix; [] when clean.
export const checkBoundaries = (root) => {
  const problems = [];
  const read = (path) => readFileSync(join(root, path), "utf8");

  if (!existsSync(join(root, "swift-layers.json"))) return ["swift-layers.json is missing: it lists what each target may import (docs/ports-and-adapters.md)."];
  let config;
  try {
    config = JSON.parse(read("swift-layers.json"));
  } catch (error) {
    return [`swift-layers.json is not valid JSON: ${error.message}`];
  }
  const sources = config.sources ?? "Sources";
  const layers = config.layers ?? {};
  if (Object.keys(layers).length === 0) return ["swift-layers.json has no layers: add a row per target, or nothing is checked."];
  if (!existsSync(join(root, "Package.swift"))) problems.push("Package.swift is missing.");
  const manifest = existsSync(join(root, "Package.swift")) ? read("Package.swift") : "";
  const targetNames = new Set(packageTargets(manifest).filter((target) => CODE_KINDS.has(target.kind)).map((target) => target.name));

  // Both directions, so a misspelled or renamed target can't leave a rule matching nothing.
  const dirs = existsSync(join(root, sources)) ? readdirSync(join(root, sources), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  for (const dir of dirs) {
    if (!(dir in layers)) problems.push(`${sources}/${dir} is a target with no row in swift-layers.json: add one, or its imports are unchecked.`);
  }
  for (const [layer, allowed] of Object.entries(layers)) {
    if (swiftFiles(root, `${sources}/${layer}`).length === 0) problems.push(`swift-layers.json row '${layer}' matches no Swift files under ${sources}/${layer}: fix the spelling, or the rule checks nothing.`);
    if (!targetNames.has(layer)) problems.push(`swift-layers.json row '${layer}' is not a target in Package.swift: fix the spelling, or the rule checks nothing.`);
    for (const used of allowed) {
      // A module a row allows must be a layer, or Apple's/system's (capitalised, no dot); a typo of a layer name is the risk.
      if (!(used in layers) && !SYSTEM_MODULES.has(used)) {
        problems.push(`layer '${layer}' allows '${used}', which is neither a layer nor a system module this check knows: fix the spelling (add the system module to SYSTEM_MODULES in boundaries.mjs if it is real).`);
      }
    }
  }
  if (manifest !== "") problems.push(...manifestProblems(manifest, layers, sources));

  // The imports: each target's files against its row.
  for (const [layer, allowed] of Object.entries(layers)) {
    for (const file of swiftFiles(root, `${sources}/${layer}`)) {
      const text = read(file);
      for (const { module, line } of importsOf(text)) {
        if (module === "Swift" || module === layer || allowed.includes(module)) continue;
        problems.push(
          `${file}:${line}: ${layer} imports '${module}', which its layer may not use (allowed: [${allowed.join(", ")}]): invert the dependency behind a port in UseCases (docs/ports-and-adapters.md).`,
        );
      }
      const clean = withoutCommentsAndStrings(text);
      for (const match of clean.matchAll(LINKER_ATTRIBUTES)) {
        problems.push(`${file}:${lineAt(clean, match.index)}: \`@_${match[1]}\` in ${layer} binds a symbol by its linker name, past every import rule: import a module the layer's row allows instead.`);
      }
      // An enum we own is switched on exhaustively: a `default:` turns a new case into silent wrong behavior.
      if ((config.noDefaultIn ?? []).includes(layer)) {
        for (const match of clean.matchAll(DEFAULT_LABEL)) {
          problems.push(`${file}:${lineAt(clean, match.index)}: \`default:\` in ${layer}: name every case instead, so adding one is a compile error here.`);
        }
      }
    }
  }
  for (const layer of config.noDefaultIn ?? []) {
    if (!(layer in layers)) problems.push(`swift-layers.json noDefaultIn names '${layer}', which is not a layer: fix the spelling, or the rule checks nothing.`);
  }

  // Tests: none switched off, because plain `swift test` is the only way the fault tests run.
  for (const file of swiftFiles(root, "Tests")) {
    const hidden = OFF_TRAIT.exec(withoutCommentsAndStrings(read(file)));
    if (hidden !== null) problems.push(`${file}: a \`.${hidden[1]}(...)\` trait: a test that can be switched off can be switched off in CI; delete the trait or the test.`);
  }

  // One fault test per fault kind: every case of the seed's FaultKind is played by some @Test.
  for (const [kind, tests] of faultTestsByKind(root)) {
    if (tests.length === 0) problems.push(`FaultKind.${kind} has no test: add a fault-injection @Test that plays \`kind: .${kind}\` (testing-swift.mdc).`);
  }
  return problems;
};

// CLI: `--root <dir>` (default: the working directory).
const main = () => {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--root");
  const root = resolve(flag === -1 ? "." : (args[flag + 1] ?? "."));
  const problems = checkBoundaries(root);
  if (problems.length > 0) {
    process.stderr.write(`✗ swift boundaries:\n${problems.map((line) => `  ${line}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write("swift boundaries: ok.\n");
  return 0;
};

// Run only as a script, so the tests can import the functions.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`✗ swift boundaries: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
