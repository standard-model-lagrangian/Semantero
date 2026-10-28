import Foundation

/// How queries are embedded for the loaded index, decided from its status and manifests.
public enum EmbeddingChoice: Sendable, Equatable {
    /// The index was built by the pplx-embed-v2-late profile (`backend: "pplx"`): the pplx service scores the rows,
    /// checked against these builds.
    case pplx(baseURL: URL, expectedHashes: [Scope: String])
    /// Ollama embeds the query with the index's own model.
    case ollama(baseURL: URL, model: String, dims: Int, instruction: String, keepAlive: String)
    /// Keyword search only, and why.
    case off(String)

    public static let defaultPplxURL = "http://127.0.0.1:11435"

    public static func choose(status s: RankerStatus, papers: IndexManifest?, notes: IndexManifest?, ollamaURL: String,
                              keepAlive: String) -> EmbeddingChoice {
        guard s.anySemantic else { return .off("the index has no vectors") }
        if (papers?.backend ?? notes?.backend) == "pplx",
           let url = URL(string: papers?.backendURL ?? notes?.backendURL ?? defaultPplxURL) {
            // Only the corpora loaded with vectors are scored; their hashes come from the builds this status describes.
            var hashes: [Scope: String] = [:]
            if s.papers?.semantic == true, let h = papers?.contentHash { hashes[.papers] = h }
            if s.notes?.semantic == true, let h = notes?.contentHash { hashes[.notes] = h }
            return .pplx(baseURL: url, expectedHashes: hashes)
        }
        guard let model = s.model, let dims = s.dims, let instruction = s.queryInstruction, let url = URL(string: ollamaURL)
        else { return .off("Ollama URL is invalid") }
        return .ollama(baseURL: url, model: model, dims: dims, instruction: instruction, keepAlive: keepAlive)
    }
}

/// What the app hears about loading.
public enum IndexEvent: Sendable, Equatable {
    case loaded(RankerStatus)
    /// The index could not be loaded; the previous engine (if any) stays.
    case failed(String)
}

/// Keeps the ranker's engine in step with the vault's index and everything that depends on it: the reloader and file
/// watcher, a 60 s safety poll, the GC that settles a reload, the memory watchdog, the embedding backend (pplx service,
/// Ollama, or none), and the query re-run after a reload.
@MainActor
public final class IndexCoordinator {
    /// What the coordinator needs from the app. Each is read when it is needed, never cached.
    public struct Hooks {
        public var panelVisible: @MainActor () -> Bool
        /// The query on screen, ranked again after every reload.
        public var query: @MainActor () -> String
        public var footprintMB: @MainActor () -> Int
        public var now: @MainActor () -> Date
        public var log: @MainActor (String) -> Void
        public var onEvent: @MainActor (IndexEvent) -> Void

        public init(panelVisible: @escaping @MainActor () -> Bool = { false }, query: @escaping @MainActor () -> String = { "" },
                    footprintMB: @escaping @MainActor () -> Int = { MemoryWatchdog.footprintMB() },
                    now: @escaping @MainActor () -> Date = { Date() }, log: @escaping @MainActor (String) -> Void = { _ in },
                    onEvent: @escaping @MainActor (IndexEvent) -> Void = { _ in }) {
            self.panelVisible = panelVisible; self.query = query; self.footprintMB = footprintMB; self.now = now
            self.log = log; self.onEvent = onEvent
        }
    }

    /// One synchronous GC this long after a reload (see JSCRanker.collectGarbage): measured 143 → ~110 MB. The delay lets
    /// the first searches on the new engine (the query on screen is re-run) finish and drop their garbage.
    public static let settleDelay: Double = 3
    /// The watcher misses an index swapped in while the app was not running or the folder did not exist yet.
    public static let pollInterval: Double = 60

    private let ranker: Ranker
    public private(set) var vault: URL
    /// The last index loaded from `vault`; nil until one has loaded.
    public private(set) var status: RankerStatus?
    /// How queries are embedded now; nil until an index has loaded.
    public private(set) var embedding: EmbeddingChoice?

    private let controller: QueryController
    private let settings: SettingsStore
    private let sleeper: Sleeper
    private var watchdog: MemoryWatchdog
    private let watchFiles: Bool
    private let hooks: Hooks
    private var reloader: IndexReloader
    private var watcher: IndexWatcher?
    private var pollTask: Task<Void, Never>?
    private(set) var loadTask: Task<Void, Never>?
    private(set) var settleTask: Task<Void, Never>?

    /// `watchFiles`: watch `<vault>/.planner` with FSEvents (tests turn it off and reload by hand).
    public init(ranker: Ranker, controller: QueryController, vault: URL, settings: SettingsStore,
                sleeper: Sleeper = SystemSleeper(), watchdog: MemoryWatchdog = MemoryWatchdog(), watchFiles: Bool = true,
                hooks: Hooks = Hooks()) {
        self.ranker = ranker; self.controller = controller; self.vault = vault; self.settings = settings
        self.sleeper = sleeper; self.watchdog = watchdog; self.watchFiles = watchFiles; self.hooks = hooks
        reloader = IndexReloader(vault: vault, ranker: ranker)
    }

    /// The app's ranker (docs/DECISIONS_AND_GAPS.md, spike S1 and "Memory pass"): JavaScriptCore for keyword search,
    /// merging and view models; Accelerate for the vector pass (option B). With the JIT tiers the app needs for its memory
    /// budget, an all-JavaScriptCore vector pass measured 20–54 ms per query against Accelerate's 2–3 ms.
    public static func makeRanker(rankerJS: URL) throws -> Ranker {
        AcceleratedRanker(inner: try JSCRanker(rankerURL: rankerJS))
    }

    /// Watches the vault, loads its index, and starts the safety poll.
    public func start() {
        openVault(vault)
        pollTask?.cancel()
        pollTask = Task { [weak self, sleeper] in
            while !Task.isCancelled {
                do { try await sleeper.sleep(seconds: Self.pollInterval) } catch { return }
                guard let self else { return }
                await self.reloadIndexes()
                await self.compactIfNeeded()
            }
        }
    }

    public func stop() {
        watcher?.stop()
        for task in [pollTask, loadTask, settleTask] { task?.cancel() }
    }

    /// (Re)starts everything that depends on the vault path: reloader, file watcher, first load. The engine answers
    /// from the old index until the new one has loaded.
    public func openVault(_ url: URL) {
        vault = url
        status = nil
        watcher?.stop()
        loadTask?.cancel()
        reloader = IndexReloader(vault: url, ranker: ranker)
        watcher = watchFiles ? IndexWatcher(directory: url.appendingPathComponent(".planner")) { [weak self] in
            Task { @MainActor in await self?.reloadIndexes() }
        } : nil
        watcher?.start()
        // Each build ends with a synchronous full GC (JSCRanker), so no compaction reloads are needed after loading.
        loadTask = Task { [weak self] in await self?.reloadIndexes() }
    }

    /// Loads the index if it changed; after a load: tell the app, schedule the settle GC, configure embedding, and rank
    /// the query on screen again.
    public func reloadIndexes() async {
        let outcome = await reloader.check()
        hooks.log("reload outcome \(String(describing: outcome).prefix(60))")
        switch outcome {
        case .reloaded(let s):
            status = s
            hooks.onEvent(.loaded(s))
            scheduleSettleGC()
            await configureEmbedding(from: s)
            await controller.setQuery(hooks.query(), force: true)
        case .failed(let message):
            hooks.onEvent(.failed(message))
        case .unchanged, .deferred:
            break
        }
    }

    /// The Ollama settings changed: rebuild the embedder for the loaded index (nothing to do before one has loaded).
    public func reconfigureEmbedding() async {
        guard let status else { return }
        await configureEmbedding(from: status)
    }

    private func configureEmbedding(from s: RankerStatus) async {
        let dirs = IndexFiles.corpusDirs(vault: vault)
        let choice = EmbeddingChoice.choose(status: s, papers: IndexManifest.read(dir: dirs.papers),
                                            notes: IndexManifest.read(dir: dirs.notes), ollamaURL: settings.ollamaURL,
                                            keepAlive: settings.ollamaKeepAlive)
        embedding = choice
        switch choice {
        case .pplx(let url, let hashes):
            let pplx = PplxClient(baseURL: url, expectedHashes: hashes)
            let rowScorer: @Sendable (String, Scope) async throws -> RowScores = { try await pplx.rowScores($0, scope: $1) }
            await controller.configure(rowScorer: rowScorer, warmUp: { await pplx.warmUp() },
                                       unreachable: "pplx service not reachable")
        case .ollama(let url, let model, let dims, let instruction, let keepAlive):
            let client = OllamaClient(baseURL: url, model: model, instruction: instruction, dims: dims, keepAlive: keepAlive)
            let embedder: @Sendable (String) async throws -> [Float] = { try await client.embedQuery($0) }
            await controller.configure(embedder: embedder, warmUp: { await client.warmUp() })
        case .off(let reason):
            await controller.configure(embedder: nil, offReason: reason)
        }
    }

    private func scheduleSettleGC() {
        settleTask?.cancel()
        settleTask = Task { [sleeper, ranker] in
            do { try await sleeper.sleep(seconds: Self.settleDelay) } catch { return }
            guard !Task.isCancelled else { return }
            await ranker.collectGarbage()
        }
    }

    /// Safety net (see MemoryWatchdog): if the footprint still grows past the threshold while the panel is hidden, swap
    /// in a fresh engine built from the same index.
    func compactIfNeeded() async {
        let mb = hooks.footprintMB()
        guard watchdog.shouldCompact(footprintMB: mb, panelVisible: hooks.panelVisible(), now: hooks.now()) else { return }
        watchdog.didCompact(at: hooks.now())
        _ = await reloader.forceReload()
        hooks.log("watchdog reload at \(mb) MB")
    }
}
