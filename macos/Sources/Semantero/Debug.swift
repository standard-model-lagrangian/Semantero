import Foundation
import Observation
import Synchronization

/// The environment variables the app reads, all in one place and read once at launch (DEVELOPMENT.md → Debugging aids).
struct LaunchOptions {
    /// `SEMANTERO_VAULT=<dir>`: use this vault instead of the setting.
    var vault: String?
    /// `SEMANTERO_SELFTEST=<json>`: drive the panel with synthetic keys, write the report there, quit (`make app-selftest`).
    var selfTestOutput: String?
    /// `SEMANTERO_SHOW_PANEL="<query>"`: open the panel with that query once the index is loaded.
    var showPanelQuery: String?
    /// `SEMANTERO_SNAPSHOT=<png>` (with `SEMANTERO_SHOW_PANEL`): save the panel to a PNG, then quit.
    var snapshotPath: String?
    /// `SEMANTERO_SNAPSHOT_ACTIONS=1`: take that snapshot with the ⌘K menu open.
    var snapshotActions: Bool
    /// `SEMANTERO_NO_HOTKEY=1`: take no hotkey and no login item.
    var noHotkey: Bool
    /// `SEMANTERO_DEBUG=1`: log to stderr (`debugLog`).
    var debug: Bool

    init(environment env: [String: String]) {
        vault = env["SEMANTERO_VAULT"]
        selfTestOutput = env["SEMANTERO_SELFTEST"]
        showPanelQuery = env["SEMANTERO_SHOW_PANEL"]
        snapshotPath = env["SEMANTERO_SNAPSHOT"]
        snapshotActions = env["SEMANTERO_SNAPSHOT_ACTIONS"] != nil
        noHotkey = env["SEMANTERO_NO_HOTKEY"] != nil
        debug = env["SEMANTERO_DEBUG"] != nil
    }

    static let current = LaunchOptions(environment: ProcessInfo.processInfo.environment)

    /// Test and measurement modes run next to the installed app: they take no hotkey and no login item.
    var isTestMode: Bool { selfTestOutput != nil || snapshotPath != nil || noHotkey }
}

/// `SEMANTERO_DEBUG=1`: timestamped lines on stderr (reloads, the memory watchdog).
func debugLog(_ message: @autoclosure () -> String) {
    guard LaunchOptions.current.debug else { return }
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
