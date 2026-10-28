import Foundation
import Synchronization

/// Sleeping that tests can control. The real one is `Task.sleep`. Every delay in SemanteroKit goes through this: the
/// query debounce, the settle GC, the safety poll, the paste settle and the file watcher's debounce.
public protocol Sleeper: Sendable {
    func sleep(seconds: Double) async throws
}

public struct SystemSleeper: Sleeper {
    public init() {}
    public func sleep(seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}

/// Collapses a burst of events into one call, `delay` seconds after the last one: each `poke` cancels the sleep the
/// previous one started.
public final class Debouncer: Sendable {
    private let sleeper: Sleeper
    private let delay: Double
    private let action: @Sendable () -> Void
    private let pending = Mutex<Task<Void, Never>?>(nil)

    public init(sleeper: Sleeper, delay: Double, action: @escaping @Sendable () -> Void) {
        self.sleeper = sleeper; self.delay = delay; self.action = action
    }

    public func poke() {
        pending.withLock { pending in
            pending?.cancel()
            pending = Task { [sleeper, delay, action] in
                do { try await sleeper.sleep(seconds: delay) } catch { return }
                guard !Task.isCancelled else { return }
                action()
            }
        }
    }

    deinit { pending.withLock { $0?.cancel() } }
}
