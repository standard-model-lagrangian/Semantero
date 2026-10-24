// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "Semantero",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "Semantero", targets: ["Semantero"]),
        .executable(name: "semantero-bench", targets: ["SemanteroBench"]),
    ],
    targets: [
        // Everything testable: no SwiftUI views.
        .target(name: "SemanteroKit"),
        // The app: menu bar item, panel, settings, Spotlight.
        .executableTarget(name: "Semantero", dependencies: ["SemanteroKit"]),
        // Spike S1: measures the ranker options (JavaScriptCore vs Accelerate) on a real or synthetic index.
        .executableTarget(name: "SemanteroBench", dependencies: ["SemanteroKit"]),
        .testTarget(name: "SemanteroKitTests", dependencies: ["SemanteroKit"]),
    ]
)
