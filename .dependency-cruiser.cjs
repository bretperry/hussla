/*
  Ports-and-adapters import rules: the hard gate that keeps src/domain pure and adapters behind ports.
  In the app: nothing at runtime; runs in `pnpm boundaries`, the edit hook, pre-push, and CI "Checks".
  Used by: package.json `boundaries` / `check`; scripts/check-edited.mjs; .github/workflows/ci.yml.
  Uses: dependency-cruiser with the swc parser (@swc/core); tsconfig.json for the `@/` alias.

  Layers and the direction they may point are explained in docs/ports-and-adapters.md. Each rule's
  `comment` is printed on a violation (`--output-type err-long`), so it is written as the fix, not
  the complaint: an agent reading it after an edit should know where the code belongs instead.

  Parser is swc, not tsc: dependency-cruiser cannot load TypeScript 7 (no JS API until 7.1) and,
  with tsc missing, it cruises 0 modules and reports green. swc parses TS without it, type-only
  imports included. When dependency-cruiser supports TS 7, dropping `parser` is optional.
*/

// npm packages src/domain may import. Empty on purpose: domain is plain TypeScript over domain
// types. Add a package only if it is pure (no I/O, no framework, no globals), e.g. "date-fns".
const DOMAIN_ALLOWED_PACKAGES = [];

// npm packages a port may import besides domain types: input schemas only.
const PORT_ALLOWED_PACKAGES = ["zod"];

// Test files and test helpers; exempt from the layering rules below (fakes wire adapters freely).
const TESTS = "(^src/test/|\\.(test|spec)\\.[cm]?[jt]sx?$)";

// Resolved-path regex for "any package except these". The `.*` also covers pnpm's real paths
// (node_modules/.pnpm/zod@4/node_modules/zod/…) since symlinks are resolved.
const npmExcept = (allowed) =>
  allowed.length === 0 ? "^" : `^(?!.*node_modules/(${allowed.join("|")})/)`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      severity: "error",
      comment:
        "src/domain is pure functions over domain types: no framework, no I/O, no server, feature, or shared-UI imports. Move I/O into a use-case (src/server/services) behind a port; move React into a feature component. See docs/ports-and-adapters.md.",
      from: { path: "^src/domain/", pathNot: TESTS },
      to: { path: "^src/(server|features|shared)/" },
    },
    {
      name: "domain-imports-no-packages",
      severity: "error",
      comment:
        "src/domain imports no npm packages or node builtins, so it can be ported to another runtime or client unchanged. If a package is genuinely pure, add it to DOMAIN_ALLOWED_PACKAGES in .dependency-cruiser.cjs with a why-comment.",
      from: { path: "^src/domain/", pathNot: TESTS },
      to: {
        dependencyTypes: ["core", "npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"],
        path: npmExcept(DOMAIN_ALLOWED_PACKAGES),
      },
    },
    {
      name: "ports-are-contracts",
      severity: "error",
      comment:
        "A port declares an interface and imports only domain types and input schemas. An implementation belongs in src/server/services (use-case) or src/server/adapters (I/O), wired in src/server/container.ts.",
      from: { path: "^src/server/ports/" },
      to: { path: "^src/(server/(services|adapters|container)|features)" },
    },
    {
      name: "ports-import-no-io-packages",
      severity: "error",
      comment:
        "A port may not name a vendor or a node builtin: that is the adapter's job. Only the packages in PORT_ALLOWED_PACKAGES (input schemas) are allowed.",
      from: { path: "^src/server/ports/" },
      to: {
        dependencyTypes: ["core", "npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"],
        path: npmExcept(PORT_ALLOWED_PACKAGES),
      },
    },
    {
      name: "adapters-only-via-composition-root",
      severity: "error",
      comment:
        "Only the composition root (src/server/container.ts) imports adapters. A use-case takes its ports as arguments; add the dependency to the use-case factory and wire the adapter in container.ts.",
      from: { pathNot: `(^src/server/(adapters|container)|${TESTS})` },
      to: { path: "^src/server/adapters/" },
    },
    {
      name: "use-cases-dont-reach-for-the-container",
      severity: "error",
      comment:
        "A use-case never imports the composition root: that turns wiring into a hidden global. Receive the port as an argument instead.",
      from: { path: "^src/server/services/", pathNot: TESTS },
      to: { path: "^src/server/container" },
    },
    {
      name: "adapters-dont-call-up",
      severity: "error",
      comment:
        "An adapter implements a port against one vendor or device and calls nothing above it. Orchestration belongs in a use-case (src/server/services).",
      from: { path: "^src/server/adapters/", pathNot: TESTS },
      to: { path: "^src/(features|server/(services|container))" },
    },
    {
      name: "features-reach-the-server-through-the-api",
      severity: "error",
      comment:
        "Feature code (UI + schemas) talks to the server through the API layer, never to a use-case, adapter, or the container directly; that would ship server code to the client. Port types are fine.",
      from: { path: "^src/features/", pathNot: TESTS },
      to: { path: "^src/server/(services|adapters|container|db)" },
    },
    {
      name: "shared-is-a-leaf",
      severity: "error",
      comment:
        "src/shared (UI primitives, hooks, lib) is imported by features and never imports them or the server. Move the code into the feature that owns it.",
      from: { path: "^src/shared/", pathNot: TESTS },
      to: { path: "^src/(features|server)/" },
    },
    {
      name: "config-is-a-leaf",
      severity: "error",
      comment:
        "src/config holds named product knobs (architecture.mdc → Knobs) and imports nothing from the app, so any layer can read a knob without a cycle.",
      from: { path: "^src/config/" },
      to: { path: "^src/(domain|features|server|shared)/" },
    },
    {
      name: "production-code-imports-no-tests",
      severity: "error",
      comment: "Production code must not import tests, fixtures, or fakes from src/test.",
      from: { pathNot: TESTS },
      to: { path: TESTS },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular imports make load order matter and hide layering mistakes. Extract the shared piece into a lower layer.",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "This import resolves to nothing: a typo, a missing dependency, or a path alias the resolver cannot see.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-non-package-json",
      severity: "error",
      comment: "This package is not in package.json. It works only by accident (hoisting) and breaks on a clean install.",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "not-to-dev-dep",
      severity: "error",
      comment: "Production code imports a devDependency, which is missing in a production install. Move it to dependencies, or keep the import in tests.",
      from: { path: "^src/", pathNot: TESTS },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    parser: "swc",
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    // Not node_modules: excluding it drops every package import from the graph, so the
    // "no packages in domain" and dev-dependency rules could never fire. doNotFollow is enough.
    exclude: { path: "(^|/)(dist|coverage)/" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".d.ts"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
