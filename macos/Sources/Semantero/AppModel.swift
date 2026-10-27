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
    @ObservationIgnored private(set) lazy var panel = PanelController(model: self)
    @ObservationIgnored private(set) lazy var executor = ActionExecutor(
        services: ActionServices(
            pasteboard: SystemPasteboard(), events: CGEventPoster(), workspace: SystemWorkspace(), system: LiveSystemState(),
            files: DiskFiles(), panel: panel, toast: ToastCenter.shared, quickLook: QuickLookService.shared),
        restoreClipboard: { [settings] in settings.restoreClipboard })
    /// Nil only when the ranker could not be built (`loadMessage` says why).
    private var index: IndexCoordinator?
    private var controller: QueryController?
    var intentService: IntentSearchService? { index?.intentService }
    private var consumeTask: Task<Void, Never>?
    /// Typed queries, sent to the controller by one task so they arrive in order (a task per keystroke could arrive out
    /// of order, leave the controller on an older query and `apply` dropping every update for the one on screen).
    private var queryInput: AsyncStream<String>.Continuation?
    private var queryTask: Task<Void, Never>?
    let hotkey = HotkeyRegistrar()
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
        _ = panel
        let ranker: Ranker
        do {
            let js = Bundle.main.url(forResource: "ranker", withExtension: "js")
                ?? URL(fileURLWithPath: "../launcher-core/dist/ranker.js")
            ranker = try IndexCoordinator.makeRanker(rankerJS: js)
        } catch {
            loadMessage = "Could not load the ranker: \(error)"
            return
        }

        let (stream, continuation) = AsyncStream<QueryUpdate>.makeStream()
        let controller = QueryController(ranker: ranker, limit: settings.resultLimit, scope: scope) { continuation.yield($0) }
        self.controller = controller
        consumeTask = Task { [weak self] in
            for await update in stream { self?.apply(update) }
        }
        let (queries, queryInput) = AsyncStream<String>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.queryInput = queryInput
        queryTask = Task { [weak self] in
            for await q in queries { await self?.controller?.setQuery(q) }
        }
        index = IndexCoordinator(
            ranker: ranker, controller: controller, vault: vaultURL, settings: settings,
            donor: SpotlightDonor(index: CoreSpotlightIndex(), stateURL: Self.supportDirectory.appendingPathComponent("spotlight.json")),
            hooks: IndexCoordinator.Hooks(
                panelVisible: { [weak self] in self?.panel.isVisible ?? false },
                query: { [weak self] in self?.query ?? "" },
                log: { debugLog($0) },
                onEvent: { [weak self] in self?.indexEvent($0) }))
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
        index?.start()
    }

    private func indexEvent(_ event: IndexEvent) {
        switch event {
        case .loaded(let s):
            status = s
            loadMessage = nil
        case .failed(let message):
            loadMessage = "Index problem: \(message)"
        }
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
            index?.openVault(vaultURL)   // also re-syncs Spotlight after loading
        } else {
            if effects.contains(.reconfigureEmbedding) { Task { await index?.reconfigureEmbedding() } }
            if effects.contains(.syncSpotlight) { Task { await index?.syncSpotlight() } }
        }
    }

    static var supportDirectory: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Semantero")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func reloadIndexes() async { await index?.reloadIndexes() }

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
        guard let ranker = index?.ranker else { return }
        let executor = self.executor
        Task { _ = await SpotlightOpenService(ranker: ranker, executor: executor).open(identifier: id) }
    }
}

/// App Intents are created by the system; this is how they reach the running app's engine.
final class IntentBridge: @unchecked Sendable {
    static let shared = IntentBridge()
    @MainActor weak var model: AppModel?
    @MainActor var service: IntentSearchService? { model?.intentService }
}
