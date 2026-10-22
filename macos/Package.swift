// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "DaitoSearch",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "DaitoSearch", targets: ["DaitoSearch"]),
        .executable(name: "daito-bench", targets: ["DaitoBench"]),
    ],
    targets: [
        // Everything testable: no SwiftUI views.
        .target(name: "DaitoSearchKit"),
        // The app: menu bar item, panel, settings, Spotlight.
        .executableTarget(name: "DaitoSearch", dependencies: ["DaitoSearchKit"]),
        // Spike S1: measures the ranker options (JavaScriptCore vs Accelerate) on a real or synthetic index.
        .executableTarget(name: "DaitoBench", dependencies: ["DaitoSearchKit"]),
        .testTarget(name: "DaitoSearchKitTests", dependencies: ["DaitoSearchKit"]),
    ]
)
