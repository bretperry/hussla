/*
  pnpm install hook: gives the OpenAPI type generator the TypeScript it was built against.
  In the app: nothing at runtime; it shapes node_modules for `pnpm api:types` only.
  Used by: pnpm, on every install (its checksum is in pnpm-lock.yaml).

  openapi-typescript prints its output through the TypeScript 5 compiler API, which it takes as a
  peer dependency. This project's own compiler is TypeScript 7 (the native port), which ships no
  JS compiler API, so the peer would resolve to a package the generator can't use. Here the peer
  becomes a private, exact-pinned dependency of the generator; nothing else sees TypeScript 5.
*/
"use strict";

const GENERATOR = "openapi-typescript";
const GENERATOR_TYPESCRIPT = "5.9.3";

// Rewrites the generator's manifest as pnpm reads it; every other package passes through untouched.
const readPackage = (manifest) => {
  if (manifest.name !== GENERATOR) return manifest;
  if (manifest.peerDependencies) delete manifest.peerDependencies.typescript;
  manifest.dependencies = { ...manifest.dependencies, typescript: GENERATOR_TYPESCRIPT };
  return manifest;
};

module.exports = { hooks: { readPackage } };
