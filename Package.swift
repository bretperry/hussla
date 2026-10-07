// swift-tools-version: 6.2

// The Swift pack's package: layers are SwiftPM targets, so a target can import only what it declares.
// In the app: an Xcode app depends on the `NoteSync` product (add the package under File > Add Package Dependencies > Add Local).
// Used by: `swift build` / `swift test` (pnpm swift:test); stacks/swift/boundaries.mjs reads it and swift-layers.json.
// Uses: Sources/<Target>, Tests/NoteSyncTests; no third-party packages.
//
// Third-party packages: pin each with `exact:` and put a comment above it saying why it is worth
// a dependency (boundaries.mjs fails a `.package(` that floats or has no comment). SwiftPM lets a
// target import a module it never declared if another target built it first, so the compiler
// alone is not the boundary: swift-layers.json lists what each target may import, and
// `pnpm swift:boundaries` reads the source.

import PackageDescription

// Every target: Swift 6 language mode (from the tools version), a warning is an error, and `any` is written out.
let strict: [SwiftSetting] = [
    .treatAllWarnings(as: .error),
    .enableUpcomingFeature("ExistentialAny"),
]

let package = Package(
    name: "App",
    // macOS is the host `swift test` runs on (no Simulator); iOS is the app. Raise them together with Xcode.
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [
        .library(name: "NoteSync", targets: ["Config", "Domain", "UseCases", "Adapters"])
    ],
    targets: [
        // Knobs and nothing else: imports no module.
        .target(name: "Config", swiftSettings: strict),
        // Pure domain logic: imports Config only.
        .target(name: "Domain", dependencies: ["Config"], swiftSettings: strict),
        // Use-cases and the ports they declare: imports Config and Domain.
        .target(name: "UseCases", dependencies: ["Config", "Domain"], swiftSettings: strict),
        // One vendor or device per adapter; the only layer that touches I/O.
        .target(name: "Adapters", dependencies: ["Config", "Domain", "UseCases"], swiftSettings: strict),
        .testTarget(
            name: "NoteSyncTests",
            dependencies: ["Config", "Domain", "UseCases", "Adapters"],
            swiftSettings: strict
        ),
    ]
)
