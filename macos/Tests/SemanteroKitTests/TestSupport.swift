import Foundation
import Synchronization
import Testing
@testable import SemanteroKit

enum Repo {
    /// …/macos/Tests/SemanteroKitTests/TestSupport.swift → the repository root.
    static let root: URL = {
        var u = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { u.deleteLastPathComponent() }
        return u
    }()
    static let papersDir = root.appendingPathComponent("tests/fixtures/search/index_small")
    static let notesDir = root.appendingPathComponent("launcher-core/test/fixtures/notes_small")
    static let rankerJS = root.appendingPathComponent("launcher-core/dist/ranker.js")
    static let shortcuts = root.appendingPathComponent("launcher-core/shortcuts.json")
    static let cases = root.appendingPathComponent("launcher-core/conformance/cases.json")
}

enum TestEnv {
    /// Note dates are shown in the machine's time zone; the conformance cases are recorded in UTC.
    static let utc: Void = { setenv("TZ", "UTC", 1); tzset(); JSCRanker.configureProcess() }()
}

func fixtureFiles() throws -> (papers: CorpusFiles, notes: CorpusFiles) {
    (try #require(try IndexFiles.read(dir: Repo.papersDir)), try #require(try IndexFiles.read(dir: Repo.notesDir)))
}

func makeJSCRanker(version: String = JSCRanker.expectedVersion) throws -> JSCRanker {
    _ = TestEnv.utc
    return try JSCRanker(rankerURL: Repo.rankerJS, expectedVersion: version)
}

func loadedJSCRanker() async throws -> JSCRanker {
    let r = try makeJSCRanker()
    let f = try fixtureFiles()
    _ = try await r.load(papers: f.papers, notes: f.notes)
    return r
}

/// A temp vault with `.planner/search` and `.planner/notes` copied from the fixtures.
func makeTempVault(papers: Bool = true, notes: Bool = true) throws -> URL {
    let vault = FileManager.default.temporaryDirectory.appendingPathComponent("semantero-test-\(UUID().uuidString)")
    let planner = vault.appendingPathComponent(".planner")
    try FileManager.default.createDirectory(at: planner, withIntermediateDirectories: true)
    if papers { try FileManager.default.copyItem(at: Repo.papersDir, to: planner.appendingPathComponent("search")) }
    if notes { try FileManager.default.copyItem(at: Repo.notesDir, to: planner.appendingPathComponent("notes")) }
    return vault
}

func rewriteManifest(_ dir: URL, _ change: (inout [String: Any]) -> Void) throws {
    let url = dir.appendingPathComponent("manifest.json")
    var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    change(&json)
    try JSONSerialization.data(withJSONObject: json).write(to: url)
}

func vm(_ id: String, title: String = "", kind: String = "paper", filePath: String? = nil, actions: [String] = ["open"],
        openUrl: String = "zotero://x", noteUrl: String? = nil, selectUrl: String? = nil, citation: String = "cit",
        wikilink: String = "[[w]]") -> ResultVM {
    ResultVM(id: id, kind: kind, title: title.isEmpty ? id : title, filePath: filePath, openUrl: openUrl, noteUrl: noteUrl,
             selectUrl: selectUrl, citation: citation, wikilink: wikilink, actions: actions)
}

/// Thread-safe call recorder.
final class CallLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ s: String) { lock.lock(); items.append(s); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
    func contains(prefix: String) -> Bool { all.contains { $0.hasPrefix(prefix) } }
}

/// Wakes waiters when the state they check may have changed. Owners call `changed()` after every mutation (never while
/// holding their own lock); `wait` registers before its first check, so a change between the check and the wait can't
/// be missed.
final class ChangeSignal: Sendable {
    private struct Waiter {
        let check: @Sendable () -> Bool
        let continuation: CheckedContinuation<Bool, Never>
        var timer: Task<Void, Never>?
    }
    private let waiters = Mutex<[UUID: Waiter]>([:])

    /// True once `check` holds; false if it still doesn't after `timeout`.
    func wait(timeout: Duration, _ check: @escaping @Sendable () -> Bool) async -> Bool {
        let id = UUID()
        return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            waiters.withLock { $0[id] = Waiter(check: check, continuation: c) }
            let timer = Task { [weak self] in
                try? await Task.sleep(for: timeout)
                if !Task.isCancelled { self?.finish(id, false) }
            }
            waiters.withLock { $0[id]?.timer = timer }
            changed()
        }
    }

    func changed() {
        let done = waiters.withLock { w -> [Waiter] in
            let ids = w.filter { $0.value.check() }.map(\.key)
            return ids.compactMap { w.removeValue(forKey: $0) }
        }
        for d in done { d.timer?.cancel(); d.continuation.resume(returning: true) }
    }

    private func finish(_ id: UUID, _ result: Bool) {
        guard let d = waiters.withLock({ $0.removeValue(forKey: id) }) else { return }
        d.timer?.cancel()
        d.continuation.resume(returning: result)
    }
}

/// Waits for `check` (re-evaluated on every `signal` change) and records a test failure at the caller if it times out.
@discardableResult
func expectEventually(_ signal: ChangeSignal, timeout: Duration = .seconds(3), _ what: String = "condition",
                      sourceLocation: SourceLocation = #_sourceLocation, _ check: @escaping @Sendable () -> Bool) async -> Bool {
    let ok = await signal.wait(timeout: timeout, check)
    if !ok { Issue.record("timed out after \(timeout) waiting for \(what)", sourceLocation: sourceLocation) }
    return ok
}

/// Sleeps until the test releases it (or returns at once when `immediate`). Cancellation ends a sleep, like the real one.
final class FakeSleeper: Sleeper, Sendable {
    private struct State { var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]; var requested: [Double] = [] }
    private let state = Mutex(State())
    private let signal = ChangeSignal()
    let immediate: Bool
    init(immediate: Bool = false) { self.immediate = immediate }

    var requested: [Double] { state.withLock { $0.requested } }
    var pending: Int { state.withLock { $0.waiters.count } }

    func sleep(seconds: Double) async throws {
        state.withLock { $0.requested.append(seconds) }
        signal.changed()
        if immediate { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                state.withLock { $0.waiters[id] = c }
                signal.changed()
                if Task.isCancelled { cancel(id) }
            }
        } onCancel: { cancel(id) }
    }
    private func cancel(_ id: UUID) {
        let c = state.withLock { $0.waiters.removeValue(forKey: id) }
        signal.changed()
        c?.resume(throwing: CancellationError())
    }
    func releaseAll() {
        let all = state.withLock { s -> [CheckedContinuation<Void, Error>] in
            let w = Array(s.waiters.values); s.waiters = [:]; return w
        }
        signal.changed()
        all.forEach { $0.resume() }
    }

    /// Returns once exactly `count` sleeps are waiting to be released; records a failure on timeout.
    func waitForPending(_ count: Int, timeout: Duration = .seconds(3), sourceLocation: SourceLocation = #_sourceLocation) async {
        await expectEventually(signal, timeout: timeout, "\(count) pending sleep(s)", sourceLocation: sourceLocation) {
            self.pending == count
        }
    }
}

final class ManualScheduler: Scheduler, @unchecked Sendable {
    private struct Job { let due: Double; let work: @Sendable () -> Void; let token: Token }
    private final class Token: Cancellable, @unchecked Sendable {
        var cancelled = false
        func cancel() { cancelled = true }
    }
    private let lock = NSLock()
    private var now = 0.0
    private var jobs: [Job] = []

    func schedule(after seconds: Double, _ work: @escaping @Sendable () -> Void) -> Cancellable {
        lock.lock(); defer { lock.unlock() }
        let t = Token()
        jobs.append(Job(due: now + seconds, work: work, token: t))
        return t
    }
    func advance(by seconds: Double) {
        lock.lock(); now += seconds
        let due = jobs.filter { $0.due <= now }
        jobs.removeAll { $0.due <= now }
        lock.unlock()
        for j in due where !j.token.cancelled { j.work() }
    }
}

/// A ranker whose answers the test controls. Everything it records or is told is behind one lock, since the code under
/// test calls it from other tasks while the test reads and sets it.
final class FakeRanker: Ranker, Sendable {
    private struct State {
        var keywordCalls: [String] = []
        var hybridCalls: [String] = []
        var rowScoreCalls: [(query: String, papers: Data?, notes: Data?)] = []
        var scopes: [Scope] = []
        var limits: [Int] = []
        var loads = 0
        var garbageCollections = 0
        var keywordResults: @Sendable (String, Scope) -> [ResultVM] = { q, _ in [vm("K:\(q)")] }
        var hybridResults: @Sendable (String, Scope) -> [ResultVM] = { q, _ in [vm("H:\(q)")] }
        var recentResults: [ResultVM] = (0..<12).map { vm("R\($0)") }
        var lookupResults: [String: ResultVM] = [:]
        var notLoaded = false
        var hybridDelay: (@Sendable (String) async -> Void)?
        var loadStatus = RankerStatus()
    }
    private let state = Mutex(State())
    /// Changes whenever a call is recorded.
    let signal = ChangeSignal()

    private func read<T: Sendable>(_ key: KeyPath<State, T> & Sendable) -> T { state.withLock { $0[keyPath: key] } }
    private func write<T: Sendable>(_ key: WritableKeyPath<State, T> & Sendable, _ value: sending T) { state.withLock { $0[keyPath: key] = value } }
    private func record(_ change: (inout State) -> Void) { state.withLock { change(&$0) }; signal.changed() }

    var keywordCalls: [String] { read(\.keywordCalls) }
    var hybridCalls: [String] { read(\.hybridCalls) }
    var rowScoreCalls: [(query: String, papers: Data?, notes: Data?)] { read(\.rowScoreCalls) }
    var scopes: [Scope] { read(\.scopes) }
    var limits: [Int] { read(\.limits) }
    var loads: Int { read(\.loads) }
    var garbageCollections: Int { read(\.garbageCollections) }
    var keywordResults: @Sendable (String, Scope) -> [ResultVM] { get { read(\.keywordResults) } set { write(\.keywordResults, newValue) } }
    var hybridResults: @Sendable (String, Scope) -> [ResultVM] { get { read(\.hybridResults) } set { write(\.hybridResults, newValue) } }
    var recentResults: [ResultVM] { get { read(\.recentResults) } set { write(\.recentResults, newValue) } }
    var lookupResults: [String: ResultVM] { get { read(\.lookupResults) } set { write(\.lookupResults, newValue) } }
    var notLoaded: Bool { get { read(\.notLoaded) } set { write(\.notLoaded, newValue) } }
    var hybridDelay: (@Sendable (String) async -> Void)? { get { read(\.hybridDelay) } set { write(\.hybridDelay, newValue) } }
    /// What `load` and `status` report.
    var loadStatus: RankerStatus { get { read(\.loadStatus) } set { write(\.loadStatus, newValue) } }

    func load(papers: CorpusFiles?, notes: CorpusFiles?) async throws -> RankerStatus {
        record { $0.loads += 1 }
        return loadStatus
    }
    func status() async throws -> RankerStatus { loadStatus }
    func shouldRunSemantic(_ query: String) async -> Bool {
        // rank.ts, without stopwords: 12+ characters, or two words with the last one 3+ characters or a digit
        if semanticText(query).count >= 12 { return true }
        let words = query.split(whereSeparator: { $0.isWhitespace })
        guard let last = words.last else { return false }
        let lastCounts = last.count >= 3 || last.contains(where: \.isNumber)
        return (lastCounts ? words.count : words.count - 1) >= 2
    }
    func keyword(_ query: String, scope: Scope, limit: Int) async throws -> [ResultVM] {
        if notLoaded { throw RankerError("no index loaded") }
        record { $0.keywordCalls.append(query); $0.scopes.append(scope); $0.limits.append(limit) }
        return keywordResults(query, scope)
    }
    func hybrid(_ query: String, queryVector: [Float], scope: Scope, limit: Int) async throws -> [ResultVM] {
        if notLoaded { throw RankerError("no index loaded") }
        record { $0.hybridCalls.append(query) }
        await hybridDelay?(query)
        return hybridResults(query, scope)
    }
    func hybridFromRowScores(_ query: String, papersScores: Data?, notesScores: Data?, scope: Scope,
                             limit: Int) async throws -> [ResultVM] {
        if notLoaded { throw RankerError("no index loaded") }
        record { $0.rowScoreCalls.append((query, papersScores, notesScores)) }
        return [vm("S:\(query)")]
    }
    func recent(limit: Int) async throws -> [ResultVM] {
        if notLoaded { throw RankerError("no index loaded") }
        return Array(recentResults.prefix(limit))
    }
    func lookup(ids: [String]) async throws -> [ResultVM] {
        if notLoaded { throw RankerError("no index loaded") }
        return ids.compactMap { lookupResults[$0] }
    }
    func collectGarbage() async { record { $0.garbageCollections += 1 } }

    func waitForHybrid(_ q: String, sourceLocation: SourceLocation = #_sourceLocation) async {
        await expectEventually(signal, "a hybrid call for \"\(q)\"", sourceLocation: sourceLocation) { self.hybridCalls.contains(q) }
    }
    func waitForKeyword(count: Int, sourceLocation: SourceLocation = #_sourceLocation) async {
        await expectEventually(signal, "\(count) keyword calls", sourceLocation: sourceLocation) { self.keywordCalls.count >= count }
    }
}

/// Collects controller updates; `wait` returns once a condition over them holds, and fails the test if it never does.
final class UpdateLog: Sendable {
    private let items = Mutex<[QueryUpdate]>([])
    private let signal = ChangeSignal()
    func add(_ u: QueryUpdate) { items.withLock { $0.append(u) }; signal.changed() }
    var all: [QueryUpdate] { items.withLock { $0 } }

    func wait(timeout: Duration = .seconds(3), sourceLocation: SourceLocation = #_sourceLocation,
              _ condition: @escaping @Sendable ([QueryUpdate]) -> Bool) async {
        if await signal.wait(timeout: timeout, { condition(self.all) }) { return }
        Issue.record("timed out after \(timeout) waiting for updates; got \(all.map { "\($0.query)/\($0.semantic)" })",
                     sourceLocation: sourceLocation)
    }
}

func physFootprint() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return kr == KERN_SUCCESS ? info.phys_footprint : 0
}

/// An in-memory papers corpus big enough that building it takes a noticeable time (dims 8).
func syntheticCorpus(papers nPapers: Int, chunksPerPaper: Int, tag: String = "big") -> CorpusFiles {
    var papers: [[String: Any]] = [], chunks: [[String: Any]] = []
    var vectors = [Float]()
    var row = 0
    var rng = SystemRandomNumberGenerator()
    func unit() { var v = (0..<8).map { _ in Float.random(in: -1...1, using: &rng) }; let n = v.reduce(0) { $0 + $1 * $1 }.squareRoot(); v = v.map { $0 / n }; vectors += v }
    for p in 0..<nPapers {
        papers.append(["key": "\(tag)\(p)", "citekey": "\(tag)\(p)", "title": "Paper \(p) about organoid hydrogel \(tag)", "authors": ["Roth"],
                       "year": 2020, "journal": NSNull(), "doi": NSNull(), "tags": [], "collections": [], "abstract": "abstract \(p)",
                       "pdfs": [["attachmentKey": "A\(p)", "pages": 3, "hasText": true, "file": "A\(p)/p.pdf"]], "abstractRow": row])
        unit(); row += 1
        for c in 0..<chunksPerPaper {
            let words = (0..<120).map { "w\(($0 * 7 + c * 13 + p) % 4000)" }.joined(separator: " ")
            chunks.append(["paper": p, "attachmentKey": "A\(p)", "page": c + 1, "text": "Stress relaxation \(words).", "row": row])
            unit(); row += 1
        }
    }
    let manifest: [String: Any] = ["format": 1, "model": "m", "dims": 8, "query_instruction": "q", "content_hash": tag, "zotero_storage": "/Z"]
    return CorpusFiles(dir: URL(fileURLWithPath: "/tmp"), manifest: try! JSONSerialization.data(withJSONObject: manifest),
                       papers: try! JSONSerialization.data(withJSONObject: papers), chunks: try! JSONSerialization.data(withJSONObject: chunks),
                       vectors: vectors.withUnsafeBufferPointer { Data(buffer: $0) }, contentHash: tag)
}

/// A preferences domain for one test, emptied first. Each test uses a fixed name: macOS keeps a domain's plist in
/// ~/Library/Preferences even after it is removed, so a new name per run left a file behind every time.
final class ScratchDefaults {
    let name: String
    let defaults: UserDefaults
    init(_ test: String) {
        name = "semantero-test-\(test)"
        defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
    }
    func remove() { defaults.removePersistentDomain(forName: name) }
}
