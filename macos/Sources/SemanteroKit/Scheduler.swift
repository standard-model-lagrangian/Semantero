import Foundation

/// Sleeping that tests can control. The real one is `Task.sleep`.
public protocol Sleeper: Sendable {
    func sleep(seconds: Double) async throws
}

public struct SystemSleeper: Sleeper {
    public init() {}
    public func sleep(seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}

/// Fire-and-forget timers (the file watcher's debounce). Tests use a manual implementation.
public protocol Scheduler: Sendable {
    @discardableResult
    func schedule(after seconds: Double, _ work: @escaping @Sendable () -> Void) -> Cancellable
}

public protocol Cancellable: Sendable { func cancel() }

public struct DispatchScheduler: Scheduler {
    private final class Token: Cancellable, @unchecked Sendable {
        let item: DispatchWorkItem
        init(_ item: DispatchWorkItem) { self.item = item }
        func cancel() { item.cancel() }
    }
    private let queue: DispatchQueue
    public init(queue: DispatchQueue = .global(qos: .utility)) { self.queue = queue }
    public func schedule(after seconds: Double, _ work: @escaping @Sendable () -> Void) -> Cancellable {
        let item = DispatchWorkItem(block: work)
        queue.asyncAfter(deadline: .now() + seconds, execute: item)
        return Token(item)
    }
}

/// Collapses a burst of events into one call, `delay` seconds after the last one.
public final class Debouncer: @unchecked Sendable {
    private let scheduler: Scheduler
    private let delay: Double
    private let lock = NSLock()
    private var pending: Cancellable?
    private let action: @Sendable () -> Void

    public init(scheduler: Scheduler, delay: Double, action: @escaping @Sendable () -> Void) {
        self.scheduler = scheduler; self.delay = delay; self.action = action
    }

    public func poke() {
        lock.lock(); defer { lock.unlock() }
        pending?.cancel()
        pending = scheduler.schedule(after: delay, action)
    }
}
