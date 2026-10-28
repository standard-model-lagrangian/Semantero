import CoreServices
import Foundation

public enum ReloadOutcome: Sendable, Equatable {
    case unchanged
    case reloaded(RankerStatus)
    /// The indexer is swapping a new index in (`<name>.tmp` / `<name>.old` exist): keep the current engine.
    case deferred
    case failed(String)
}

/// Loads the corpora into a ranker, and again only when a corpus's `content_hash` changes. Never swaps in a
/// half-written index: while the indexer is mid-swap, or a load fails, the engine stays as it is.
public actor IndexReloader {
    private let vault: URL
    private let ranker: Ranker
    private var loadedHashes: [String?]?
    public private(set) var reloadCount = 0
    /// How many of those reloads replaced only the notes corpus.
    public private(set) var partialReloadCount = 0
    /// Notes indexes up to this size (chunks.json bytes) are swapped in place on the ranker's actor (a few ms per MB);
    /// bigger ones take the full rebuild, which runs off the actor.
    public static let partialReloadLimit = 4_000_000

    public init(vault: URL, ranker: Ranker) { self.vault = vault; self.ranker = ranker }

    /// Loads the current index again into a fresh engine even though nothing changed. JavaScriptCore only gives back some
    /// memory when a virtual machine is torn down, so the app's memory watchdog calls this when the footprint keeps
    /// growing while the panel is hidden (see MemoryWatchdog). The old engine answers queries until the new one is ready.
    public func forceReload() async -> ReloadOutcome { await check(force: true) }

    /// One check at a time: a check that arrives while another is loading waits for it, then looks again (so a burst
    /// of file events never loads the same index twice, and an older load can't land after a newer one).
    public func check(force: Bool = false) async -> ReloadOutcome {
        // Whoever sees a finished task clears it: awaiting a finished task does not suspend, so leaving that to the task's
        // creator would let waiters spin on the actor and starve it.
        while let r = running {
            _ = await r.value
            if running == r { running = nil }
        }
        let task = Task { await self.performCheck(force: force) }
        running = task
        let outcome = await task.value
        if running == task { running = nil }
        return outcome
    }

    private var running: Task<ReloadOutcome, Never>?

    private func performCheck(force: Bool) async -> ReloadOutcome {
        if force { loadedHashes = nil }
        let dirs = IndexFiles.corpusDirs(vault: vault)
        if IndexFiles.swapInProgress(dir: dirs.papers) || IndexFiles.swapInProgress(dir: dirs.notes) { return .deferred }
        let hashes = [IndexFiles.manifestHash(of: dirs.papers), IndexFiles.manifestHash(of: dirs.notes)]
        if let loadedHashes, loadedHashes == hashes { return .unchanged }
        // Only the notes changed: swap them in without touching the papers corpus.
        if let loadedHashes, loadedHashes[0] == hashes[0], let partial = ranker as? NotesReloading {
            do {
                let notes = try IndexFiles.read(dir: dirs.notes)
                if (notes?.chunks.count ?? 0) <= Self.partialReloadLimit {
                    if (notes?.contentHash).flatMap({ $0.isEmpty ? nil : $0 }) != hashes[1] { return .deferred }
                    let s = try await partial.reloadNotes(notes)
                    self.loadedHashes = hashes
                    reloadCount += 1
                    partialReloadCount += 1
                    return .reloaded(s)
                }
            } catch {
                return .failed(Self.describe(error))
            }
        }
        do {
            let papers = try IndexFiles.read(dir: dirs.papers)
            let notes = try IndexFiles.read(dir: dirs.notes)
            // Re-read the hashes of what was actually read: a swap that landed in between means try again later.
            let readHashes: [String?] = [papers?.contentHash, notes?.contentHash]
            if readHashes.map({ $0?.isEmpty == false ? $0 : nil }) != hashes { return .deferred }
            let s = try await ranker.load(papers: papers, notes: notes)
            loadedHashes = hashes
            reloadCount += 1
            return .reloaded(s)
        } catch {
            return .failed(Self.describe(error))
        }
    }
}

extension IndexReloader {
    /// A message a person can act on. macOS protects ~/Documents (where vaults usually live): a refusal there means the
    /// app has not been allowed to read it yet.
    static func describe(_ error: Error) -> String {
        let ns = error as NSError
        let posix = (ns.userInfo[NSUnderlyingErrorKey] as? NSError).flatMap { $0.domain == NSPOSIXErrorDomain ? $0.code : nil }
        let denied = (ns.domain == NSCocoaErrorDomain && ns.code == NSFileReadNoPermissionError)
            || posix == Int(EPERM) || posix == Int(EACCES)
            || (ns.domain == NSPOSIXErrorDomain && (ns.code == Int(EPERM) || ns.code == Int(EACCES)))
        if denied {
            return "Semantero isn't allowed to read your vault. Allow it in System Settings → Privacy & Security → "
                + "Files and Folders (Documents), then choose Reload Indexes."
        }
        return "\(error)"
    }
}

/// FSEvents on `<vault>/.planner`; every burst of events becomes one `onChange` after the debounce.
public final class IndexWatcher: @unchecked Sendable {
    private var stream: FSEventStreamRef?
    private let directory: URL
    private let debouncer: Debouncer
    private let queue = DispatchQueue(label: "semantero.indexwatcher")

    public init(directory: URL, sleeper: Sleeper = SystemSleeper(), debounce: Double = 0.5,
                onChange: @escaping @Sendable () -> Void) {
        self.directory = directory
        self.debouncer = Debouncer(sleeper: sleeper, delay: debounce, action: onChange)
    }

    deinit { stop() }

    @discardableResult
    public func start() -> Bool {
        stop()
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            Unmanaged<IndexWatcher>.fromOpaque(info).takeUnretainedValue().debouncer.poke()
        }
        guard let s = FSEventStreamCreate(nil, callback, &context, [directory.path] as CFArray,
                                          FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.1,
                                          FSEventStreamCreateFlags(kFSEventStreamCreateFlagNone)) else { return false }
        FSEventStreamSetDispatchQueue(s, queue)
        guard FSEventStreamStart(s) else { FSEventStreamInvalidate(s); FSEventStreamRelease(s); return false }
        stream = s
        return true
    }

    public func stop() {
        guard let s = stream else { return }
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
        stream = nil
    }

    /// For tests: behaves like a file event.
    public func poke() { debouncer.poke() }
}
