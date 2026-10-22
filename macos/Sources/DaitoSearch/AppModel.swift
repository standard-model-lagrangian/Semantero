import AppKit
import DaitoSearchKit
import Foundation
import Observation
import ServiceManagement

/// Which ranker the app runs. Decided by spike S1 (docs/DECISIONS_AND_GAPS.md): all JavaScriptCore (option A), which met
/// every budget once signed with the JIT entitlement. `.javaScriptCoreWithAccelerate` (option B) is built, tested against
/// the same conformance cases, and ready if the vector pass ever exceeds its budget.
enum RankerOption { case javaScriptCore, javaScriptCoreWithAccelerate }
let rankerOption: RankerOption = .javaScriptCore

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    // What the views render
    var query = "" { didSet { if query != oldValue { Task { await controller?.setQuery(query) } } } }
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
    private var pollTask: Task<Void, Never>?
    private var compactionTask: Task<Void, Never>?
    private var watchdog = MemoryWatchdog()
    let hotkey = HotkeyRegistrar()
    var panel: PanelController!
    private var lastQueryAt = Date.distantPast

    private init() {
        let url = Bundle.main.url(forResource: "shortcuts", withExtension: "json")
            ?? URL(fileURLWithPath: "../launcher-core/shortcuts.json")
        shortcuts = (try? ShortcutTable(url: url)) ?? (try! ShortcutTable(data: Data("{\"reserved\":[],\"actions\":[]}".utf8)))
        scope = settings.scope
    }

    var vaultURL: URL { URL(fileURLWithPath: settings.vaultPath, isDirectory: true) }
    var results: [ResultVM] { selection.results }

    // MARK: start-up

    func start() {
        panel = PanelController(model: self)
        executor = ActionExecutor(
            services: ActionServices(
                pasteboard: SystemPasteboard(), events: CGEventPoster(), workspace: SystemWorkspace(), system: LiveSystemState(),
                files: DiskFiles(), panel: panel, toast: ToastCenter.shared, quickLook: QuickLookService.shared),
            restoreClipboard: { [settings] in settings.restoreClipboard })
        do {
            guard let js = Bundle.main.url(forResource: "ranker", withExtension: "js")
                    ?? Optional(URL(fileURLWithPath: "../launcher-core/dist/ranker.js")) else { return }
            let jsc = try JSCRanker(rankerURL: js)
            ranker = rankerOption == .javaScriptCoreWithAccelerate ? AcceleratedRanker(inner: jsc) : jsc
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
        intentService = IntentSearchService(ranker: ranker, embedder: nil)
        IntentBridge.shared.model = self

        // Test modes run next to the installed app: they take no hotkey and no login item.
        let env = ProcessInfo.processInfo.environment
        if env["DAITO_SELFTEST"] == nil && env["DAITO_SNAPSHOT"] == nil {
            registerHotkey()
            applyLaunchAtLogin()
        }
        if let out = ProcessInfo.processInfo.environment["DAITO_SELFTEST"] { Task { await SelfTest.run(model: self, output: out) } }
        // Debugging aid: DAITO_SHOW_PANEL="<query>" opens the panel with that query once the index is loaded.
        if let q = ProcessInfo.processInfo.environment["DAITO_SHOW_PANEL"] {
            Task {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                self.panel.show()
                self.query = q
                // DAITO_SNAPSHOT=<png path>: save the panel's view to a PNG (no screen-recording permission) and quit.
                if let path = ProcessInfo.processInfo.environment["DAITO_SNAPSHOT"] {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    // DAITO_SNAPSHOT_ACTIONS=1: capture with the ⌘K menu open.
                    if ProcessInfo.processInfo.environment["DAITO_SNAPSHOT_ACTIONS"] != nil {
                        self.showActionMenu = true
                        try? await Task.sleep(nanoseconds: 800_000_000)
                    }
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

    /// (Re)starts everything that depends on the vault path: reloader, file watcher, first load and compaction.
    private func openVault() {
        guard let ranker else { return }
        watcher?.stop()
        compactionTask?.cancel()
        reloader = IndexReloader(vault: vaultURL, ranker: ranker)
        watcher = IndexWatcher(directory: vaultURL.appendingPathComponent(".planner")) { [weak self] in
            Task { @MainActor in await self?.reloadIndexes() }
        }
        watcher?.start()
        compactionTask = Task {
            await reloadIndexes()
            // Two compaction reloads: each swaps in a fresh engine, and from the second one on JavaScriptCore gives back
            // the ~650 MB the first loads churned through (measured, spike S1; see IndexReloader.forceReload).
            if await compact(reason: "start-up") { Task { await syncSpotlight() } }
        }
    }

    /// Two fresh-engine swaps, 4 s apart. JavaScriptCore frees the memory a build churned through only when a virtual
    /// machine is torn down *after* that garbage was collected, so one swap is not enough (measured: one swap after the
    /// idle re-growth went 455 → 916 MB; two swaps settle at ~100 MB).
    private func compact(reason: String) async -> Bool {
        var ok = false
        for round in 1...2 {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if Task.isCancelled { return false }
            if case .reloaded = await reloader?.forceReload() { ok = true }
            if ProcessInfo.processInfo.environment["DAITO_DEBUG"] != nil {
                fputs("daito: \(Date().formatted(date: .omitted, time: .standard)) \(reason) compaction \(round) → \(MemoryWatchdog.footprintMB()) MB\n", stderr)
            }
        }
        return ok
    }

    /// Gives JavaScriptCore's retained memory back by swapping in a fresh engine (see MemoryWatchdog).
    private func compactIfNeeded() async {
        let mb = MemoryWatchdog.footprintMB()
        guard watchdog.shouldCompact(footprintMB: mb, panelVisible: panel.isVisible, now: Date()) else { return }
        watchdog.didCompact(at: Date())
        _ = await compact(reason: "watchdog at \(mb) MB")
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
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Daito Search")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: index reloads

    func reloadIndexes() async {
        guard let reloader else { return }
        let outcome = await reloader.check()
        if ProcessInfo.processInfo.environment["DAITO_DEBUG"] != nil {
            fputs("daito: \(Date().formatted(date: .omitted, time: .standard)) reload outcome \(String(describing: outcome).prefix(60))\n", stderr)
        }
        switch outcome {
        case .reloaded(let s):
            status = s
            loadMessage = nil
            await configureEmbedding(from: s)
            await controller?.setQuery(query)
            Task { await syncSpotlight() }
        case .failed(let message):
            loadMessage = "Index problem: \(message)"
        case .unchanged, .deferred:
            break
        }
    }

    private func configureEmbedding(from s: RankerStatus) async {
        guard let controller, let model = s.model, let dims = s.dims, let instruction = s.queryInstruction, s.anySemantic,
              let url = URL(string: settings.ollamaURL) else {
            await controller?.configure(embedder: nil, offReason: s.anySemantic ? "Ollama URL is invalid" : "the index has no vectors")
            intentService = IntentSearchService(ranker: ranker!, embedder: nil)
            return
        }
        let client = OllamaClient(baseURL: url, model: model, instruction: instruction, dims: dims)
        await controller.configure(embedder: { try await client.embedQuery($0) }, warmUp: { await client.warmUp() })
        intentService = IntentSearchService(ranker: ranker!, embedder: { try await client.embedQuery($0) })
    }

    private func syncSpotlight() async {
        guard let donor else { return }
        if ProcessInfo.processInfo.environment["DAITO_DEBUG"] != nil { fputs("daito: \(Date().formatted(date: .omitted, time: .standard)) spotlight sync\n", stderr) }
        let dirs = IndexFiles.corpusDirs(vault: vaultURL)
        let read = { (dir: URL, name: String) in try? Data(contentsOf: dir.appendingPathComponent(name)) }
        let settings = SpotlightSettings(papers: self.settings.spotlightPapers, noteTitles: self.settings.spotlightNoteTitles,
                                         noteText: self.settings.spotlightNoteText)
        let papersManifest = read(dirs.papers, "manifest.json").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        _ = try? await donor.sync(
            papers: read(dirs.papers, "papers.json"), notes: read(dirs.notes, "papers.json"),
            chunks: self.settings.spotlightNoteText ? read(dirs.notes, "chunks.json") : nil, settings: settings,
            zoteroStorage: papersManifest?["zotero_storage"] as? String, vault: vaultURL.path)
    }

    // MARK: results

    private var lastAppliedQuery: (String, Scope)?

    private func apply(_ update: QueryUpdate) {
        guard update.query == query, update.scope == scope else { return }
        if lastAppliedQuery.map({ $0 != (update.query, update.scope) }) ?? true { selection.queryChanged() }
        lastAppliedQuery = (update.query, update.scope)
        selection.apply(update.results)
        semantic = update.semantic
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
        Task { await controller?.panelOpened(); await reloadIndexes() }
        if query.isEmpty { Task { await controller?.setQuery("") } }
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
        } catch { /* running from a build folder: registration only works for an installed app */ }
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
