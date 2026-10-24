import Foundation
import Testing
@testable import DaitoSearchKit

enum Repo {
    /// …/macos/Tests/DaitoSearchKitTests/TestSupport.swift → the repository root.
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
    let vault = FileManager.default.temporaryDirectory.appendingPathComponent("daito-test-\(UUID().uuidString)")
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

/// Sleeps until the test releases it (or returns at once when `immediate`). Cancellation ends a sleep, like the real one.
final class FakeSleeper: Sleeper, @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]
    private(set) var requested: [Double] = []
    var immediate: Bool
    init(immediate: Bool = false) { self.immediate = immediate }

    func sleep(seconds: Double) async throws {
        let now = lock.withLock { requested.append(seconds); return immediate }
        if now { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                lock.withLock { waiters[id] = c }
                if Task.isCancelled { cancel(id) }
            }
        } onCancel: { cancel(id) }
    }
    private func cancel(_ id: UUID) {
        let c = lock.withLock { waiters.removeValue(forKey: id) }
        c?.resume(throwing: CancellationError())
    }
    var pending: Int { lock.withLock { waiters.count } }
    func releaseAll() {
        let all = lock.withLock { () -> [CheckedContinuation<Void, Error>] in
            let w = Array(waiters.values); waiters = [:]; return w
        }
        all.forEach { $0.resume() }
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

/// A ranker whose answers the test controls.
final class FakeRanker: Ranker, @unchecked Sendable {
    private let lock = NSLock()
    private var _keywordCalls: [String] = []
    private var _hybridCalls: [String] = []
    var scopes: [Scope] = []
    var limits: [Int] = []
    var keywordResults: @Sendable (String, Scope) -> [ResultVM] = { q, _ in [vm("K:\(q)")] }
    var hybridResults: @Sendable (String, Scope) -> [ResultVM] = { q, _ in [vm("H:\(q)")] }
    var recentResults: [ResultVM] = (0..<12).map { vm("R\($0)") }
    var lookupResults: [String: ResultVM] = [:]
    var notLoaded = false
    var hybridDelay: (@Sendable (String) async -> Void)?

    var keywordCalls: [String] { lock.lock(); defer { lock.unlock() }; return _keywordCalls }
    var hybridCalls: [String] { lock.lock(); defer { lock.unlock() }; return _hybridCalls }

    func load(papers: CorpusFiles?, notes: CorpusFiles?) async throws -> RankerStatus { RankerStatus() }
    func status() async throws -> RankerStatus { RankerStatus() }
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
        lock.withLock { _keywordCalls.append(query); scopes.append(scope); limits.append(limit) }
        return keywordResults(query, scope)
    }
    func hybrid(_ query: String, queryVector: [Float], scope: Scope, limit: Int) async throws -> [ResultVM] {
        if notLoaded { throw RankerError("no index loaded") }
        lock.withLock { _hybridCalls.append(query) }
        await hybridDelay?(query)
        return hybridResults(query, scope)
    }
    private var _rowScoreCalls: [(query: String, papers: Data?, notes: Data?)] = []
    var rowScoreCalls: [(query: String, papers: Data?, notes: Data?)] { lock.lock(); defer { lock.unlock() }; return _rowScoreCalls }
    func hybridFromRowScores(_ query: String, papersScores: Data?, notesScores: Data?, scope: Scope,
                             limit: Int) async throws -> [ResultVM] {
        if notLoaded { throw RankerError("no index loaded") }
        lock.withLock { _rowScoreCalls.append((query, papersScores, notesScores)) }
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
}

/// Collects controller updates; `wait` polls until a condition holds.
final class UpdateLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [QueryUpdate] = []
    func add(_ u: QueryUpdate) { lock.lock(); items.append(u); lock.unlock() }
    var all: [QueryUpdate] { lock.lock(); defer { lock.unlock() }; return items }

    @discardableResult
    func wait(timeout: Double = 3, _ condition: ([QueryUpdate]) -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition(all) { return true }
            try? await Task.sleep(nanoseconds: 3_000_000)
        }
        return condition(all)
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
