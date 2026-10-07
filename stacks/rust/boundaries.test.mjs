/*
  The Rust boundary check fails loudly: an inward dependency, a package in domain, a typo'd layer row, a crate with no row.
  In the app: nothing at runtime; runs in `pnpm test:harness` while this pack is installed.
  Used by: node:test (`node --test`), with node:assert; needs `cargo` on PATH (the pack's toolchain).
  Uses: stacks/rust/boundaries.mjs (checkLayers, and the CLI against throwaway workspaces).

  Lives in the pack, so removing the pack removes it. The pure cases feed checkLayers metadata; the
  CLI cases write real workspaces to a temp dir and run the script, which is the "fixture where
  domain imports an adapter crate" of the plan: it must exit 1 with the fix in the message.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkLayers, checkSources, hasWorkspaceLints } from "./boundaries.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "boundaries.mjs");

// The seed's layer map and crates, as `cargo metadata --no-deps` reports them.
const layers = {
  domain: { "may-use": [], external: [] },
  app: { "may-use": ["domain"], external: ["thiserror", "tokio"] },
  adapters: { "may-use": ["domain", "app"], external: "*" },
};
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const dep = (name, kind = null, source = REGISTRY) => ({ name, kind, source });
// The pure cases read no manifests; the lints check has its own cases below.
// A manifest reader where only `app` forgot to opt in.
const manifestOf = (path) => (path.startsWith("/app/") ? '[package]\nname = "app"\n' : "[lints]\nworkspace = true\n");
const optedIn = { readText: () => "[lints]\nworkspace = true\n" };
const clean = () => ({
  metadata: { layers: structuredClone(layers) },
  packages: [
    { name: "domain", dependencies: [dep("proptest", "dev")] },
    { name: "app", dependencies: [dep("domain"), dep("tokio"), dep("thiserror")] },
    { name: "adapters", dependencies: [dep("domain"), dep("app"), dep("reqwest"), dep("proptest", "dev")] },
  ],
});
const withDeps = (name, dependencies) => {
  const metadata = clean();
  metadata.packages.find((pack) => pack.name === name).dependencies = dependencies;
  return metadata;
};

describe("checkLayers", () => {
  it("passes the seed layout", () => {
    assert.deepEqual(checkLayers(clean(), optedIn), []);
  });

  it("fails domain importing an adapter crate, and says how to fix it", () => {
    const problems = checkLayers(withDeps("domain", [dep("adapters")]), optedIn);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /crate 'domain' depends on 'adapters'.*port/);
  });

  it("fails domain (or app) importing an inner-to-outer crate, dev-dependencies included", () => {
    assert.equal(checkLayers(withDeps("app", [dep("adapters")]), optedIn).length, 1);
    assert.match(checkLayers(withDeps("domain", [dep("app", "dev")]), optedIn)[0], /\(dev\)/);
  });

  it("a crate's dev-dependency on itself is allowed (it only enables test features), a normal one is not", () => {
    assert.deepEqual(checkLayers(withDeps("adapters", [dep("domain"), dep("app"), dep("adapters", "dev")]), optedIn), []);
    assert.equal(checkLayers(withDeps("adapters", [dep("domain"), dep("app"), dep("adapters")]), optedIn).length, 1);
  });

  it("fails any registry crate in domain, and one outside app's allow-list", () => {
    assert.match(checkLayers(withDeps("domain", [dep("serde")]), optedIn)[0], /registry crate 'serde'/);
    assert.match(checkLayers(withDeps("app", [dep("domain"), dep("reqwest")]), optedIn)[0], /registry crate 'reqwest'/);
    // A build dependency counts as a dependency.
    assert.equal(checkLayers(withDeps("domain", [dep("cc", "build")]), optedIn).length, 1);
  });

  it("a misspelled layer row fails instead of checking nothing", () => {
    const metadata = clean();
    metadata.metadata.layers = { ...layers, domian: layers.domain };
    delete metadata.metadata.layers.domain;
    const problems = checkLayers(metadata, optedIn);
    assert.ok(problems.some((line) => /row 'domian' matches no crate/.test(line)));
    assert.ok(problems.some((line) => /crate 'domain' has no row/.test(line)));
  });

  it("a misspelled may-use fails", () => {
    const metadata = clean();
    metadata.metadata.layers.app = { ...layers.app, "may-use": ["domian"] };
    assert.ok(checkLayers(metadata, optedIn).some((line) => /may-use 'domian' matches no crate/.test(line)));
  });

  it("an external that is a string, not an array, fails instead of matching substrings", () => {
    const metadata = clean();
    metadata.metadata.layers.app = { ...layers.app, external: "tokio" };
    assert.ok(checkLayers(metadata, optedIn).some((line) => /external must be an array/.test(line)));
  });

  it("a path or git dependency outside the workspace fails, whatever its name", () => {
    assert.match(checkLayers(withDeps("adapters", [dep("domain"), dep("app"), dep("vendored", null, null)]), optedIn)[0], /outside the workspace/);
    assert.match(checkLayers(withDeps("adapters", [dep("domain"), dep("app"), dep("forked", null, "git+https://example.com/x")]), optedIn)[0], /git\+https/);
  });

  it("a crate without [lints] workspace = true fails, naming the fix", () => {
    const metadata = clean();
    metadata.packages.forEach((pack) => (pack.manifest_path = `/${pack.name}/Cargo.toml`));
    const problems = checkLayers(metadata, { readText: manifestOf });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /crate 'app' has no `\[lints\] workspace = true`/);
  });

  it("a workspace with no layer table fails", () => {
    assert.match(checkLayers({ packages: clean().packages }, optedIn)[0], /no \[workspace.metadata.layers\]/);
  });
});

describe("hasWorkspaceLints", () => {
  it("accepts both spellings, and nothing else", () => {
    assert.equal(hasWorkspaceLints("[package]\nname = \"a\"\n\n[lints]\nworkspace = true\n"), true);
    assert.equal(hasWorkspaceLints('[package]\nname = "a"\nlints.workspace = true\n'), true);
    assert.equal(hasWorkspaceLints('[package]\nname = "a"\n'), false);
    // Another table's `workspace = true`, a commented one, and an opt-out are not it.
    assert.equal(hasWorkspaceLints("[dependencies]\nx = { workspace = true }\nworkspace = true\n"), false);
    assert.equal(hasWorkspaceLints("[lints]\n# workspace = true\n"), false);
    assert.equal(hasWorkspaceLints("[lints]\nworkspace = false\n"), false);
  });
});

// A throwaway workspace on disk: `crates` maps a crate name to its Cargo.toml [dependencies] lines.
const scratch = mkdtempSync(join(tmpdir(), "rust-boundaries-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const workspace = (layerRows, crates, { lints = true, lib = () => "" } = {}) => {
  const root = join(scratch, `ws${counter++}`);
  mkdirSync(root);
  writeFileSync(join(root, "Cargo.toml"), `[workspace]\nresolver = "3"\nmembers = ["crates/*"]\n\n[workspace.lints.clippy]\nunwrap_used = "deny"\n\n[workspace.metadata.layers]\n${layerRows}\n`);
  for (const [name, deps] of Object.entries(crates)) {
    mkdirSync(join(root, "crates", name, "src"), { recursive: true });
    writeFileSync(join(root, "crates", name, "Cargo.toml"), `[package]\nname = "${name}"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\n${deps}\n${lints ? "\n[lints]\nworkspace = true\n" : ""}`);
    writeFileSync(join(root, "crates", name, "src", "lib.rs"), lib(name));
  }
  return root;
};
const run = (root) => spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
const rows = `domain = { may-use = [], external = [] }\napp = { may-use = ["domain"], external = [] }\nadapters = { may-use = ["domain", "app"], external = "*" }`;

describe("boundaries.mjs against real workspaces", () => {
  it("a clean three-crate workspace exits 0", () => {
    const root = workspace(rows, { domain: "", app: 'domain = { path = "../domain" }', adapters: 'app = { path = "../app" }' });
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("domain importing an adapter crate exits 1, naming both crates", () => {
    const root = workspace(rows, { domain: 'adapters = { path = "../adapters" }', app: 'domain = { path = "../domain" }', adapters: 'app = { path = "../app" }' });
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /crate 'domain' depends on 'adapters'/);
  });

  it("a layer row spelled wrong exits 1", () => {
    const root = workspace(rows.replace("domain = {", "domian = {"), { domain: "", app: 'domain = { path = "../domain" }', adapters: 'app = { path = "../app" }' });
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /matches no crate/);
  });

  it("a directory that is not a cargo workspace exits 1 rather than passing", () => {
    const result = run(scratch);
    assert.equal(result.status, 1);
  });

  it("a crate missing [lints] workspace = true exits 1, naming the fix", () => {
    const root = workspace(rows, { domain: "", app: 'domain = { path = "../domain" }', adapters: 'app = { path = "../app" }' }, { lints: false });
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /add it, or none of the workspace's clippy denies/);
  });

  it("a crate that includes another crate's source fails, by #[path] and by include!", () => {
    const crates = { domain: "", app: 'domain = { path = "../domain" }', adapters: 'app = { path = "../app" }' };
    const reaches = { "#[path]": '#[path = "../../app/src/lib.rs"]\nmod stolen;\n', "include!": 'include!("../../app/src/lib.rs");\n', "include_str!": 'const X: &str = include_str!("../../app/Cargo.toml");\n' };
    for (const [what, body] of Object.entries(reaches)) {
      const result = run(workspace(rows, crates, { lib: (name) => (name === "domain" ? body : "") }));
      assert.equal(result.status, 1, what);
      assert.match(result.stderr, /leaves the crate|reaches outside the crate/, what);
    }
    // Inside the crate is fine.
    assert.equal(checkSources([]).length, 0);
    const inside = run(workspace(rows, crates, { lib: (name) => (name === "domain" ? '#[path = "x.rs"]\nmod x;\n' : "") }));
    assert.equal(inside.status, 0, inside.stderr);
  });

  it("the lint floor bites: a crate that calls .unwrap() fails `cargo clippy -- -D warnings`", () => {
    const crates = { domain: "", app: 'domain = { path = "../domain" }', adapters: 'app = { path = "../app" }' };
    const root = workspace(rows, crates, { lib: (name) => (name === "domain" ? "pub fn first(x: Option<u8>) -> u8 { x.unwrap() }\n" : "") });
    const clippy = spawnSync("cargo", ["clippy", "--workspace", "--", "-D", "warnings"], { cwd: root, encoding: "utf8" });
    assert.notEqual(clippy.status, 0, clippy.stdout + clippy.stderr);
    assert.match(clippy.stderr, /unwrap_used/);
    // The same workspace with the call removed is clean: the failure above is the lint, not the setup.
    writeFileSync(join(root, "crates", "domain", "src", "lib.rs"), "pub fn first(x: Option<u8>) -> Option<u8> { x }\n");
    const fixed = spawnSync("cargo", ["clippy", "--workspace", "--", "-D", "warnings"], { cwd: root, encoding: "utf8" });
    assert.equal(fixed.status, 0, fixed.stderr);
  });
});
