import Foundation
import Observation
import Synchronization

/// `SEMANTERO_DEBUG=1`: timestamped lines on stderr (reloads, Spotlight syncs, the memory watchdog).
func debugLog(_ message: @autoclosure () -> String) {
    guard ProcessInfo.processInfo.environment["SEMANTERO_DEBUG"] != nil else { return }
    fputs("semantero: \(Date().formatted(date: .omitted, time: .standard)) \(message())\n", stderr)
}

/// Suspends until `condition` holds, re-checking it whenever the observable state it reads changes (so it must read
/// `@Observable` properties, such as `AppModel`'s), or until `timeout` passes. Returns whether the condition held. For
/// the debug modes and the self-test, which need "the index is loaded" or "the results are in", not a guessed delay.
@MainActor
func waitUntil(timeout: Duration = .seconds(10), _ condition: @escaping @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while !condition() {
        guard ContinuousClock.now < deadline else { return false }
        // Wake on the next change to anything `condition` reads, or at the deadline, whichever comes first.
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let resume = Once { c.resume() }
            let timer = Task { try? await Task.sleep(until: deadline); resume() }
            withObservationTracking { _ = condition() } onChange: { timer.cancel(); resume() }
        }
    }
    return true
}

/// Runs its action the first time it is called; later calls do nothing.
private final class Once: Sendable {
    private let done = Mutex(false)
    private let action: @Sendable () -> Void
    init(_ action: @escaping @Sendable () -> Void) { self.action = action }
    func callAsFunction() {
        if done.withLock({ (d: inout Bool) in defer { d = true }; return !d }) { action() }
    }
}
