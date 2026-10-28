import Foundation
import JavaScriptCore

/// Measurements for `semantero-bench` (`--heapprobe`, `--dropprobe`); the app never calls these.
extension JSCRanker {
    /// The current engine's JavaScriptCore heap (after an optional synchronous full GC).
    public func heapStatistics(collectFirst: Bool = false) -> [String: Double] {
        guard let engine else { return [:] }
        return autoreleasepool {
            if collectFirst { JSCPrivate.collectNow(engine.ctx) }
            return JSCPrivate.heapStatistics(engine.ctx)
        }
    }

    /// Live objects by type after a synchronous full GC, largest first.
    public func objectTypeCounts() -> [(String, Int)] {
        guard let engine else { return [] }
        return autoreleasepool { JSCPrivate.collectNow(engine.ctx); return JSCPrivate.objectTypeCounts(engine.ctx) }
    }

    /// Runs JavaScript in the current engine and returns its string result.
    public func evaluateForDiagnostics(_ script: String) -> String {
        guard let engine else { return "" }
        return autoreleasepool { engine.ctx.evaluateScript(script)?.toString() ?? "" }
    }
}
