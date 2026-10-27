import AppKit
import SemanteroKit
import Foundation
import Observation
import ServiceManagement

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    // What the views render
    var query = "" { didSet { if query != oldValue { queryInput?.yield(query) } } }
    var scope: Scope = .all {
        didSet {
            guard scope != oldValue else { return }
            settings.scope = scope
            Task { await controller?.setScope(scope) }
        }
    }
    private(set) var selection = SelectionModel()
    private(set) var semantic: SemanticState = .notRun
    private(set) var status: RankerStatus?
    private(set) var loadMessage: String? = "Loading index…"
    var showActionMenu = false
    var showDetail: Bool { get { settings.showDetail } set { settings.showDetail = newValue } }

    let settings = SettingsStore()
    let shortcuts: ShortcutTable
    private(set) var executor: ActionExecutor!
    private(set) var intentService: IntentSearchService?
    private var ranker: Ranker?
    private var controller: QueryController?
    private var reloader: IndexReloader?
    private var watcher: IndexWatcher?
    private var donor: SpotlightDonor?
    private var updates: AsyncStream<QueryUpdate>.Continuation?
    private var consumeTask: Task<Void, Never>?
    /// Typed queries, sent to the controller by one task so they arrive in order (a task per keystroke could arrive out
    /// of order, leave the controller on an older query and `apply` dropping every update for the one on screen).
    private var queryInput: AsyncStream<String>.Continuation?
    private var queryTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var loadTask: Task<Void, Never>?
    private var watchdog = MemoryWatchdog()
    let hotkey = HotkeyRegistrar()
    var panel: PanelController!
    private var lastQueryAt = Date.distantPast

    private init() {
        // First launch under the new name: bring the settings over from Daito Search (the app is not sandboxed, so the
        // old domain is readable). Its Spotlight entries are not reused: this app donates its own.
        SettingsStore.importLegacySettings(UserDefaults.standard.persistentDomain(forName: SettingsStore.legacyDomain),
                                           into: .standard)
        let url = Bundle.main.url(forResource: "shortcuts", withExtension: "json")
            ?? URL(fileURLWithPath: "../launcher-core/shortcuts.json")
        shortcuts = (try? ShortcutTable(url: url)) ?? (try! ShortcutTable(data: Data("{\"reserved\":[],\"actions\":[]}".utf8)))
        scope = settings.scope
    }

    /// `SEMANTERO_VAULT` overrides the setting for measurement runs, so they never touch the installed app's settings.
    var vaultURL: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["SEMANTERO_VAULT"] ?? settings.vaultPath, isDirectory: true)
    }
    var results: [ResultVM] { selection.results }

    // MARK: start-up

    func start() {
        panel = PanelController(model: self)
        executor = ActionExecutor(
            services: ActionServices(
                pasteboard: SystemPasteboard(), events: CGEventPoster(), workspace: SystemWorkspace(), system: LiveSystemState(),
                files: DiskFiles(), panel: panel, toast: ToastCenter.shared, quickLook: QuickLookService.shared),
            restoreClipboard: { [settings] in settings.restoreClipboard })
        // The ranker (docs/DECISIONS_AND_GAPS.md, spike S1 and "Memory pass"): JavaScriptCore for keyword search, merging
        // and view models; Accelerate for the vector pass (option B). With the JIT tiers the app needs for its memory
        // budget, an all-JavaScriptCore vector pass measured 20–54 ms per query against Accelerate's 2–3 ms.
        do {
            let js = Bundle.main.url(forResource: "ranker", withExtension: "js")
                ?? URL(fileURLWithPath: "../launcher-core/dist/ranker.js")
            ranker = AcceleratedRanker(inner: try JSCRanker(rankerURL: js))
        } catch {
            loadMessage = "Could not load the ranker: \(error)"
            return
        }
        let ranker = ranker!
        donor = SpotlightDonor(index: CoreSpotlightIndex(), stateURL: Self.supportDirectory.appendingPathComponent("spotlight.json"))

        let (stream, continuation) = AsyncStream<QueryUpdate>.makeStream()
        updates = continuation
        controller = QueryController(ranker: ranker, limit: settings.resultLimit, scope: scope) { continuation.yield($0) }
        consumeTask = Task { [weak self] in
            for await update in stream { self?.apply(update) }
        }
        let (queries, queryInput) = AsyncStream<String>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.queryInput = queryInput
        queryTask = Task { [weak self] in
            for await q in queries { await self?.controller?.setQuery(q) }
        }
        intentService = IntentSearchService(ranker: ranker, embedder: nil)
        IntentBridge.shared.model = self

        // Test modes run next to the installed app: they take no hotkey and no login item.
        let env = ProcessInfo.processInfo.environment
        if env["SEMANTERO_SELFTEST"] == nil && env["SEMANTERO_SNAPSHOT"] == nil && env["SEMANTERO_NO_HOTKEY"] == nil {
            registerHotkey()
            applyLaunchAtLogin()
        }
        if let out = env["SEMANTERO_SELFTEST"] { Task { await SelfTest.run(model: self, output: out) } }
        // Debugging aid: SEMANTERO_SHOW_PANEL="<query>" opens the panel with that query once the index is loaded.
        if let q = env["SEMANTERO_SHOW_PANEL"] {
            Task {
                _ = await waitUntil(timeout: .seconds(30)) { self.status != nil || self.loadMessage != "Loading index…" }
                self.panel.show()
                self.query = q
                // SEMANTERO_SNAPSHOT=<png path>: save the panel's view to a PNG (no screen-recording permission) and quit.
                if let path = env["SEMANTERO_SNAPSHOT"] {
                    // The results for `q`, semantic merge included (or a definite "off": a cold model can take seconds).
                    _ = await waitUntil(timeout: .seconds(30)) { self.resultsSettled(for: q) }
                    // SEMANTERO_SNAPSHOT_ACTIONS=1: capture with the ⌘K menu open.
                    if env["SEMANTERO_SNAPSHOT_ACTIONS"] != nil { self.showActionMenu = true }
                    self.panel.snapshot(to: path)
                    NSApplication.shared.terminate(nil)
                }
            }
        }
        openVault()
        // The watcher misses an index swapped in while the app was not running or the folder did not exist yet.
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                await self?.reloadIndexes()
                await self?.compactIfNeeded()
            }
        }
    }

    /// (Re)starts everything that depends on the vault path: reloader, file watcher, first load.
    private func openVault() {
        guard let ranker else { return }
        watcher?.stop()
        loadTask?.cancel()
        reloader = IndexReloader(vault: vaultURL, ranker: ranker)
        watcher = IndexWatcher(directory: vaultURL.appendingPathComponent(".planner")) { [weak self] in
            Task { @MainActor in await self?.reloadIndexes() }
        }
        watcher?.start()
        // Each build ends with a synchronous full GC (JSCRanker), so no compaction reloads are needed after loading.
        loadTask = Task { await reloadIndexes() }
    }

    /// One synchronous GC a few seconds after a reload (see JSCRanker.collectGarbage): measured 143 → ~110 MB. The delay
    /// lets the first searches on the new engine (the app re-runs the query on screen) finish and drop their garbage.
    private var settleTask: Task<Void, Never>?
    private func scheduleSettleGC() {
        settleTask?.cancel()
        settleTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled, let ranker = self?.ranker else { return }
            await ranker.collectGarbage()
        }
    }

    /// Safety net (see MemoryWatchdog): if the footprint still grows past the threshold while hidden, swap in a fresh engine.
    private func compactIfNeeded() async {
        let mb = MemoryWatchdog.footprintMB()
        guard watchdog.shouldCompact(footprintMB: mb, panelVisible: panel.isVisible, now: Date()) else { return }
        watchdog.didCompact(at: Date())
        _ = await reloader?.forceReload()
        debugLog("watchdog reload at \(mb) MB")
    }

    /// Applies a saved Settings change now, redoing only what that change affects.
    func applySettings(from old: SettingsSnapshot) {
        let effects = SettingsEffect.between(old, SettingsSnapshot(settings))
        if effects.contains(.registerHotkey) { registerHotkey() }
        if effects.contains(.applyLoginItem) { applyLaunchAtLogin() }
        if effects.contains(.applyResultLimit) { Task { await controller?.setLimit(settings.resultLimit) } }
        if effects.contains(.reopenVault) {
            status = nil
            loadMessage = "Loading index…"
            selection.apply([])
            openVault()   // also re-syncs Spotlight after loading
        } else {
            if effects.contains(.reconfigureEmbedding), let status { Task { await configureEmbedding(from: status) } }
            if effects.contains(.syncSpotlight) { Task { await syncSpotlight() } }
        }
    }

    static var supportDirectory: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Semantero")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: index reloads

    func reloadIndexes() async {
        guard let reloader else { return }
        let outcome = await reloader.check()
        debugLog("reload outcome \(String(describing: outcome).prefix(60))")
        switch outcome {
        case .reloaded(let s):
            status = s
            loadMessage = nil
            scheduleSettleGC()
            await configureEmbedding(from: s)
            await controller?.setQuery(query, force: true)
            Task { await syncSpotlight() }
        case .failed(let message):
            loadMessage = "Index problem: \(message)"
        case .unchanged, .deferred:
            break
        }
    }

    private func configureEmbedding(from s: RankerStatus) async {
        if let controller, s.anySemantic, let pplx = pplxClient(for: s) {
            await controller.configure(rowScorer: { try await pplx.rowScores($0, scope: $1) }, warmUp: { await pplx.warmUp() },
                                       unreachable: "pplx service not reachable")
            intentService = IntentSearchService(ranker: ranker!, embedder: nil, rowScorer: { try await pplx.rowScores($0, scope: $1) })
            return
        }
        guard let controller, let model = s.model, let dims = s.dims, let instruction = s.queryInstruction, s.anySemantic,
              let url = URL(string: settings.ollamaURL) else {
            await controller?.configure(embedder: nil, offReason: s.anySemantic ? "Ollama URL is invalid" : "the index has no vectors")
            intentService = IntentSearchService(ranker: ranker!, embedder: nil)
            return
        }
        let client = OllamaClient(baseURL: url, model: model, instruction: instruction, dims: dims,
                                  keepAlive: settings.ollamaKeepAlive)
        await controller.configure(embedder: { try await client.embedQuery($0) }, warmUp: { await client.warmUp() })
        intentService = IntentSearchService(ranker: ranker!, embedder: { try await client.embedQuery($0) })
    }

    /// The index was built by the pplx-embed-v2-late profile (`backend: "pplx"` in its manifests): semantic scores come
    /// from the pplx service, checked against the builds loaded now (`status` comes from the same reload).
    private func pplxClient(for s: RankerStatus) -> PplxClient? {
        let dirs = IndexFiles.corpusDirs(vault: vaultURL)
        let manifest = { (dir: URL) in
            (try? Data(contentsOf: dir.appendingPathComponent("manifest.json")))
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
        let pm = manifest(dirs.papers), nm = manifest(dirs.notes)
        guard (pm?["backend"] ?? nm?["backend"]) as? String == "pplx" else { return nil }
        var hashes: [Scope: String] = [:]
        if s.papers?.semantic == true, let h = pm?["content_hash"] as? String { hashes[.papers] = h }
        if s.notes?.semantic == true, let h = nm?["content_hash"] as? String { hashes[.notes] = h }
        let url = URL(string: (pm?["backend_url"] ?? nm?["backend_url"]) as? String ?? "http://127.0.0.1:11435")
        return url.map { PplxClient(baseURL: $0, expectedHashes: hashes) }
    }

    private func syncSpotlight() async {
        guard let donor else { return }
        debugLog("spotlight sync")
        let dirs = IndexFiles.corpusDirs(vault: vaultURL)
        let read = { (dir: URL, name: String) in try? Data(contentsOf: dir.appendingPathComponent(name)) }
        let settings = SpotlightSettings(papers: self.settings.spotlightPapers, noteTitles: self.settings.spotlightNoteTitles,
                                         noteText: self.settings.spotlightNoteText)
        let papersManifest = read(dirs.papers, "manifest.json").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        do {
            _ = try await donor.sync(
                papers: read(dirs.papers, "papers.json"), notes: read(dirs.notes, "papers.json"),
                chunks: self.settings.spotlightNoteText ? read(dirs.notes, "chunks.json") : nil, settings: settings,
                zoteroStorage: papersManifest?["zotero_storage"] as? String, vault: vaultURL.path)
        } catch {
            debugLog("spotlight sync failed, nothing changed: \(error)")   // retried on the next reload
        }
    }

    // MARK: results

    private var lastAppliedQuery: (String, Scope)?

    private func apply(_ update: QueryUpdate) {
        guard update.query == query, update.scope == scope else { return }
        // A whitespace-only edit is the same query: the selection stays where it was moved to.
        if lastAppliedQuery.map({ semanticText($0.0) != semanticText(update.query) || $0.1 != update.scope }) ?? true {
            selection.queryChanged()
        }
        lastAppliedQuery = (update.query, update.scope)
        selection.apply(update.results)
        semantic = update.semantic
    }

    /// The list on screen is `q`'s, with its semantic merge in (or semantic search definitely not running).
    func resultsSettled(for q: String) -> Bool {
        guard query == q, lastAppliedQuery?.0 == q else { return false }
        if case .pending = semantic { return false }
        return true
    }

    func moveSelection(_ delta: Int) { selection.move(delta) }
    func select(id: String) { selection.select(id: id) }

    // MARK: actions

    /// Self-test only: when set, actions are recorded here instead of being carried out.
    var recordedActions: [String]?

    func run(_ actionID: String, on vm: ResultVM? = nil) {
        guard let vm = vm ?? selection.selected, vm.actions.contains(actionID) else { return }
        showActionMenu = false
        if recordedActions != nil { recordedActions?.append("\(actionID) \(vm.id)"); return }
        Task {
            let outcome = await executor.run(actionID, on: vm)
            if case .failed(let message) = outcome { ToastCenter.shared.show(message, action: nil) }
        }
    }

    func runChord(_ chord: KeyChord) -> Bool {
        guard let id = shortcuts.actionID(for: chord), let vm = selection.selected, vm.actions.contains(id) else { return false }
        run(id, on: vm)
        return true
    }

    // MARK: panel

    func panelWillShow() {
        if Date().timeIntervalSince(lastQueryAt) > 60 { query = "" }
        showActionMenu = false
        Task { await controller?.panelOpened() }
        Task { await reloadIndexes() }
        if query.isEmpty { Task { await controller?.setQuery("", force: true) } }
    }
    func panelDidHide() { lastQueryAt = Date() }

    func registerHotkey() {
        let spec = (try? HotkeySpec(parsing: settings.hotkey)) ?? (try! HotkeySpec(parsing: "⌥Space"))
        let ok = hotkey.register(spec) { [weak self] in Task { @MainActor in self?.panel.toggle() } }
        if !ok { ToastCenter.shared.show("Could not register the hotkey \(spec). Pick another in Settings.", action: nil) }
    }

    /// Registers the login item only for an installed copy: from a build folder it would point at a path that moves.
    func applyLaunchAtLogin() {
        let path = Bundle.main.bundleURL.path
        guard path.hasPrefix("/Applications/") || path.hasPrefix(NSHomeDirectory() + "/Applications/") else { return }
        do {
            if settings.launchAtLogin { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            debugLog("login item: \(error)")
        }
    }

    var statusLine: String {
        guard let status else { return loadMessage ?? "Loading…" }
        let p = status.papers.map { "\($0.count) papers" } ?? "no papers index"
        let n = status.notes.map { "\($0.count) notes" } ?? "no notes index"
        return "\(p), \(n)" + (status.anySemantic ? "" : ", keyword only")
    }

    func openSpotlightResult(id: String) {
        guard let ranker, let executor else { return }
        Task { _ = await SpotlightOpenService(ranker: ranker, executor: executor).open(identifier: id) }
    }
}

/// App Intents are created by the system; this is how they reach the running app's engine.
final class IntentBridge: @unchecked Sendable {
    static let shared = IntentBridge()
    @MainActor weak var model: AppModel?
    @MainActor var service: IntentSearchService? { model?.intentService }
}
