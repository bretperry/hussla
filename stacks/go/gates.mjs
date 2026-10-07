#!/usr/bin/env node
// Proves the Go pack's lint and boundary gates still bite: plants a violation of each on a scratch copy and fails unless golangci-lint reports it.
// In the app: nothing at runtime; `pnpm go:gates`, one of the Go pack's checks (pnpm check, CI).
// Used by: stacks/go/pack.json `checks` (script `go:gates`); tested by stacks/go/gates.test.mjs.
// Uses: golangci-lint and go on PATH, go.mod, .golangci.yml, internal/, stacks/go/gates.project.json (this project's layer directories).
//
// Why this exists: depguard matches a rule's `files` globs against paths, and a glob that matches
// nothing is silent. Misspell `internal/domain` in .golangci.yml and `golangci-lint run` still
// prints "0 issues" while every boundary is off. So the gate is tested, not trusted. Before any
// lint it checks, statically: every directory under internal/ is covered by some rule glob (a new
// `internal/store` with no rule fails), no file in internal/ hides behind a build tag, and no
// `//nolint` directive lists nolintlint (which would silence the check that demands a reason).
// Then each probe below is a file that breaks one rule, copied into a scratch module with the
// project's own config, and its linter must name it. Nothing is written to the real tree.
//
// This file is harness-synced, so it knows layer *roles* (domain, app, config, adapters,
// testsupport) and nothing about this project's paths: those are in gates.project.json.

// Node builtins only.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Knob: how long the scratch lint may run. A cold build cache is the slow case.
const LINT_TIMEOUT_MS = 180_000;

// Knob: names a `//go:build` line may use inside internal/. OS and architecture tags choose a
// file per platform and so can't hide a file from every platform at once; anything else (a custom
// tag, `ignore`) can, and depguard only reads the files the build selects.
const PLATFORM_TAGS = new Set([
  "aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "js", "linux", "nacl", "netbsd", "openbsd", "plan9", "solaris", "wasip1", "windows", "zos", "unix",
  "386", "amd64", "arm", "arm64", "loong64", "mips", "mipsle", "mips64", "mips64le", "ppc64", "ppc64le", "riscv64", "s390x", "wasm", "sparc64",
]);

// The project root is the working directory the core (or you) runs this in.
const root = process.cwd();

// Stops with a message; a failed gate is never a quiet exit.
const fail = (message) => {
  process.stderr.write(`go gates: ${message}\n`);
  process.exit(1);
};

// Runs a command; returns its result, or stops when the tool is missing.
const tool = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: LINT_TIMEOUT_MS, ...options });
  if (result.error?.code === "ENOENT") fail(`\`${command}\` is not on PATH. Install it (the Go pack's rule go.mdc → Tools lists the pinned versions).`);
  return result;
};

// golangci-lint v2 only: the config below is v2's schema, and a v1 binary would misread it.
const version = /version (\d+)\./.exec(tool("golangci-lint", ["version"]).stdout ?? "");
if (version === null || version[1] !== "2") fail("needs golangci-lint v2 (found something else); the pinned version is in .github/workflows/ci.yml.");

// The module path: the probes import from it, and .golangci.yml must name the same one.
const goMod = readFileSync(join(root, "go.mod"), "utf8");
const module = /^module\s+(\S+)/m.exec(goMod)?.[1];
if (module === undefined) fail("go.mod has no `module` line.");
const config = readFileSync(join(root, ".golangci.yml"), "utf8");
if (!config.includes(`${module}/internal/`)) {
  fail(`.golangci.yml never mentions ${module}/internal/; after \`go mod edit -module\`, replace the old module path in .golangci.yml too.`);
}

// This project's layer directories, by role.
const layersFile = join(root, "stacks/go/gates.project.json");
if (!existsSync(layersFile)) fail("stacks/go/gates.project.json is missing; it maps each layer role to this project's directory.");
const layers = JSON.parse(readFileSync(layersFile, "utf8"));
for (const role of ["domain", "app", "config", "adapters", "testsupport"]) {
  if (typeof layers[role] !== "string") fail(`stacks/go/gates.project.json has no '${role}' directory.`);
}

// Every .go file under a directory, as repo-relative paths.
const goFiles = (dir) =>
  existsSync(join(root, dir)) ? readdirSync(join(root, dir), { recursive: true }).filter((name) => name.endsWith(".go")).map((name) => `${dir}/${name}`.replaceAll("\\", "/")) : [];

// The first directory under `dir` (shallowest first) holding a non-test .go file, and its package name:
// where a probe for that layer goes, so it joins the layer's own package.
const probeSite = (dir) => {
  const sources = goFiles(dir).filter((path) => !path.endsWith("_test.go")).toSorted((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const first = sources[0];
  if (first === undefined) fail(`${dir} has no Go source files; stacks/go/gates.project.json and the depguard rules in .golangci.yml must name the directories your layers live in.`);
  const pkg = /^package\s+(\w+)/m.exec(readFileSync(join(root, first), "utf8"))?.[1];
  if (pkg === undefined) fail(`${first} has no package clause.`);
  return { dir: dirname(first), pkg };
};

// ---- Static checks on the real tree: everything below fails before any lint runs.
const problems = [];

// A depguard `files` glob as a regex: `**/` any leading directories, `**` anything, `*` within a name.
const globToRegex = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\u0000")
      .replace(/\*\*/g, "\u0001")
      .replace(/\*/g, "[^/]*")
      .replaceAll("\u0000", "(?:.*/)?")
      .replaceAll("\u0001", ".*")}$`,
  );
// Positive globs only: a `!` negation excludes, it never covers.
const ruleGlobs = [...config.matchAll(/^\s*-\s*"(\*\*\/[^"]+)"/gm)].map((match) => globToRegex(match[1] ?? ""));

// Every directory directly under internal/ must be covered by a rule, so a new layer can't start life unguarded.
const internalDirs = existsSync(join(root, "internal")) ? readdirSync(join(root, "internal"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `internal/${entry.name}`) : [];
for (const dir of new Set([...internalDirs, ...Object.values(layers).filter((path) => existsSync(join(root, path)))])) {
  if (!ruleGlobs.some((pattern) => pattern.test(`${dir}/zz.go`))) {
    problems.push(`${dir} is covered by no depguard rule in .golangci.yml: add one (a misspelled glob and a new unguarded layer look the same).`);
  }
}

// Build tags and nolint directives, in every Go file under internal/.
for (const path of goFiles("internal")) {
  const text = readFileSync(join(root, path), "utf8");
  for (const line of text.split("\n")) {
    const tag = /^\s*\/\/\s*(?:go:build|\+build)\s+(.*)$/.exec(line)?.[1];
    if (tag !== undefined) {
      const custom = (tag.match(/[A-Za-z0-9_.]+/g) ?? []).filter((name) => !PLATFORM_TAGS.has(name));
      if (custom.length > 0) problems.push(`${path}: build tag '${custom.join(" ")}' can hide the file from depguard and every linter; only OS/arch tags are allowed in internal/ (or set run.build-tags in .golangci.yml and extend PLATFORM_TAGS).`);
    }
    if (/\/\/\s*nolint:[^\n]*\bnolintlint\b/.test(line)) problems.push(`${path}: a //nolint directive listing nolintlint silences the check that demands a reason; remove 'nolintlint' from it.`);
  }
}
if (problems.length > 0) fail(`${problems.length} static problem(s):\n${problems.map((line) => `  ✗ ${line}`).join("\n")}`);

// ---- Probes.
const domain = probeSite(layers.domain);
const app = probeSite(layers.app);
const configLayer = probeSite(layers.config);

// A stub package per layer the probes import; empty, so it can't form an import cycle.
const stubs = {
  adapter: { dir: `${layers.adapters}/zzgate`, path: `${module}/${layers.adapters}/zzgate` },
  app: { dir: `${layers.app}/zzgate`, path: `${module}/${layers.app}/zzgate` },
  testsupport: { dir: `${layers.testsupport}/zzgate`, path: `${module}/${layers.testsupport}/zzgate` },
  store: { dir: `${dirname(layers.app)}/zzstore`, path: `${module}/${dirname(layers.app)}/zzstore` },
};

// What each probe plants (it must compile and make no import cycle, or the type error hides every other finding).
const probe = (dir, file, source, linter, proves) => ({ file: `${dir}/${file}`, source, linter, proves });
const importing = (pkg, path) => `package ${pkg}\n\nimport _ "${path}"\n`;
// Each enum probe declares its own enum, named by `tag`, so two in one package can't collide.
const enumSource = (pkg, tag, body) => `package ${pkg}\n\ntype zzEnum${tag} int\n\nconst (\n\tzzA${tag} zzEnum${tag} = iota\n\tzzB${tag}\n)\n\n${body}\n`;
const probes = [
  probe(domain.dir, "zz_gate_app.go", importing(domain.pkg, stubs.app.path), "depguard", "domain may not import a use-case"),
  probe(domain.dir, "zz_gate_adapter.go", importing(domain.pkg, stubs.adapter.path), "depguard", "domain may not import an adapter"),
  probe(domain.dir, "zz_gate_io.go", importing(domain.pkg, "net/http"), "depguard", "domain may not import I/O"),
  probe(domain.dir, "zz_gate_third_party.go", importing(domain.pkg, "pgregory.net/rapid"), "depguard", "domain may not import a third-party package"),
  probe(domain.dir, "zz_gate_generated.go", `// Code generated by the gate. DO NOT EDIT.\n\n${importing(domain.pkg, "net/http")}`, "depguard", "a 'Code generated' header must not exempt a file"),
  probe(domain.dir, "zz_gate_test_adapter_test.go", importing(`${domain.pkg}_test`, stubs.adapter.path), "depguard", "domain tests have a rule too (a glob that matches no top-level test file would not)"),
  probe(domain.dir, "zz_gate_nolint.go", `package ${domain.pkg}\n\nimport _ "net/http" //nolint:depguard\n`, "nolintlint", "a //nolint with no reason is rejected"),
  probe(domain.dir, "zz_gate_format.go", `package ${domain.pkg}\n\nvar   ZzGateFormat  =  1\n`, "gofumpt", "formatting is enforced"),
  probe(domain.dir, "zz_gate_switch.go", enumSource(domain.pkg, "S", "func zzSwitch(e zzEnumS) int {\n\tswitch e {\n\tcase zzAS:\n\t\treturn 1\n\t}\n\treturn 0\n}\n\nvar _ = zzSwitch"), "exhaustive", "a switch on an enum must name every member"),
  probe(domain.dir, "zz_gate_map.go", enumSource(domain.pkg, "M", "var _ = map[zzEnumM]int{zzAM: 1}"), "exhaustive", "a map keyed by an enum must name every member"),
  probe(configLayer.dir, "zz_gate_layer.go", importing(configLayer.pkg, stubs.adapter.path), "depguard", "config is a leaf and imports no layer"),
  probe(app.dir, "zz_gate_adapter.go", importing(app.pkg, stubs.adapter.path), "depguard", "a use-case may not import an adapter"),
  probe(app.dir, "zz_gate_io.go", importing(app.pkg, "net/http"), "depguard", "a use-case may not import I/O"),
  probe(app.dir, "zz_gate_store.go", importing(app.pkg, stubs.store.path), "depguard", "a use-case may import only the inner layers, not a new internal package"),
  probe(app.dir, "zz_gate_testsupport.go", importing(app.pkg, stubs.testsupport.path), "depguard", "production code never imports test support"),
  probe(app.dir, "zz_gate_errors.go", `package ${app.pkg}\n\nimport "errors"\n\nvar errZz = errors.New("zz")\n\nfunc zzCompare(err error) bool { return err == errZz }\n\nvar _ = zzCompare\n`, "errorlint", "an error is compared with errors.Is, not =="),
  probe(app.dir, "zz_gate_wrap.go", `package ${app.pkg}\n\nimport "${stubs.app.path}"\n\nfunc zzWrap() error { return zzgate.Fail() }\n\nvar _ = zzWrap\n`, "wrapcheck", "an error from another package is wrapped before it is returned"),
  probe(`${layers.adapters}/zzprobe`, "zz_gate.go", importing("zzprobe", stubs.testsupport.path), "depguard", "an adapter never imports test support"),
  probe(`${layers.testsupport}/zzprobe`, "zz_gate.go", importing("zzprobe", stubs.adapter.path), "depguard", "a fake never imports the real adapter"),
];

// The scratch module: the project's go.mod, go.sum, lint config, and internal/, plus the probes and the stubs.
const scratch = mkdtempSync(join(tmpdir(), "go-gates-"));
try {
  for (const name of ["go.mod", "go.sum", ".golangci.yml"]) if (existsSync(join(root, name))) cpSync(join(root, name), join(scratch, name));
  cpSync(join(root, "internal"), join(scratch, "internal"), { recursive: true });
  const put = (path, source) => {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), source);
  };
  for (const [name, { dir }] of Object.entries(stubs)) put(`${dir}/stub.go`, `package zz${name === "store" ? "store" : "gate"}\n${dir === stubs.app.dir ? "\nfunc Fail() error { return nil }\n" : ""}`);
  for (const { file, source } of probes) put(file, source);

  // No caps: the defaults hide repeats of one message, and a probe is exactly that.
  const lint = tool("golangci-lint", ["run", "--max-issues-per-linter", "0", "--max-same-issues", "0", "--show-stats=false", "--output.text.print-issued-lines=false", "./..."], { cwd: scratch });
  const lines = `${lint.stdout ?? ""}${lint.stderr ?? ""}`.split("\n");

  // A probe passes when some issue line names its file and its linter.
  const missed = probes.filter(({ file, linter }) => !lines.some((line) => line.startsWith(`${file}:`) && line.endsWith(`(${linter})`)));
  if (missed.length > 0) {
    process.stderr.write(`go gates: ${missed.length} of ${probes.length} gates did not bite. Each planted violation must be reported; a lint that says nothing here would say nothing about real code.\n`);
    for (const { file, linter, proves } of missed) process.stderr.write(`  ✗ ${linter} should report ${file} (${proves})\n`);
    process.stderr.write(`\ngolangci-lint on the scratch copy said:\n${lines.slice(0, 40).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`go gates: all ${probes.length} planted violations were reported.\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
