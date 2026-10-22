import Foundation

public enum SemanticState: Sendable, Equatable {
    case notRun            // the query is too short to embed
    case pending           // keyword results shown, semantic on its way
    case merged            // semantic results merged in
    case off(String)       // why semantic search is off (Ollama unreachable, index has no vectors, ...)
}

public struct QueryUpdate: Sendable, Equatable {
    public let seq: Int
    public let query: String
    public let scope: Scope
    public let results: [ResultVM]
    public let semantic: SemanticState
}

/// Turns keystrokes into result updates: keyword results immediately, semantic results after a pause, and stale
/// responses dropped by sequence number.
public actor QueryController {
    private let ranker: Ranker
    private let sleeper: Sleeper
    private let debounce: Double
    private var limit: Int
    private var embedder: (@Sendable (String) async throws -> [Float])?
    private var warm: (@Sendable () async -> Void)?
    private var semanticAvailable = true
    private var semanticOffReason: String?
    private var onUpdate: @Sendable (QueryUpdate) -> Void

    private var seq = 0
    private var query = ""
    private var scope: Scope
    private var semanticTask: Task<Void, Never>?

    public init(ranker: Ranker, sleeper: Sleeper = SystemSleeper(), debounce: Double = 0.2, limit: Int = 15,
                scope: Scope = .all, onUpdate: @escaping @Sendable (QueryUpdate) -> Void) {
        self.ranker = ranker; self.sleeper = sleeper; self.debounce = debounce; self.limit = limit
        self.scope = scope; self.onUpdate = onUpdate
    }

    /// Configure query embedding after an index (re)load; nil disables semantic search with a reason.
    public func configure(embedder: (@Sendable (String) async throws -> [Float])?, warmUp: (@Sendable () async -> Void)? = nil,
                          offReason: String? = nil) {
        self.embedder = embedder
        self.warm = warmUp
        semanticAvailable = embedder != nil
        semanticOffReason = embedder == nil ? (offReason ?? "semantic search is off") : nil
    }

    public func panelOpened() async { await warm?() }

    public func setScope(_ new: Scope) { scope = new; run() }
    /// Applies a new result limit and re-runs the current query.
    public func setLimit(_ new: Int) { limit = max(1, new); run() }
    public func setQuery(_ text: String) { query = text; run() }
    public var currentSeq: Int { seq }

    private func run() {
        seq += 1
        let mySeq = seq, q = query, s = scope
        semanticTask?.cancel()
        semanticTask = nil
        Task { await self.keywordPhase(seq: mySeq, query: q, scope: s) }
    }

    private func keywordPhase(seq mySeq: Int, query q: String, scope s: Scope) async {
        let kw = (try? await ranker.keyword(q, scope: s, limit: limit)) ?? []
        guard mySeq == seq else { return }
        var wantsSemantic = false
        if !q.trimmingCharacters(in: .whitespaces).isEmpty { wantsSemantic = await ranker.shouldRunSemantic(q) }
        guard mySeq == seq else { return }
        let state: SemanticState = !wantsSemantic ? .notRun : (semanticAvailable ? .pending : .off(semanticOffReason ?? ""))
        onUpdate(QueryUpdate(seq: mySeq, query: q, scope: s, results: kw, semantic: state))
        guard wantsSemantic, semanticAvailable else { return }
        semanticTask = Task { await self.semanticPhase(seq: mySeq, query: q, scope: s, keyword: kw) }
    }

    private func semanticPhase(seq mySeq: Int, query q: String, scope s: Scope, keyword kw: [ResultVM]) async {
        do { try await sleeper.sleep(seconds: debounce) } catch { return }
        guard mySeq == seq, let embedder else { return }
        do {
            let vector = try await embedder(q)
            guard mySeq == seq else { return }
            let merged = try await ranker.hybrid(q, queryVector: vector, scope: s, limit: limit)
            guard mySeq == seq else { return }
            onUpdate(QueryUpdate(seq: mySeq, query: q, scope: s, results: merged, semantic: .merged))
        } catch {
            guard mySeq == seq else { return }
            onUpdate(QueryUpdate(seq: mySeq, query: q, scope: s, results: kw, semantic: .off("Ollama not reachable")))
        }
    }
}

/// Which row is highlighted. Once you have moved the selection, the same result stays selected across re-ranks while it
/// is still listed; until then the top result is selected, so ↵ right after typing opens the best match even when
/// semantic results re-rank the list.
public struct SelectionModel: Sendable, Equatable {
    public private(set) var results: [ResultVM] = []
    public private(set) var selectedID: String?
    private var userMoved = false

    public init() {}

    /// A new query: the selection follows the top result again until moved.
    public mutating func queryChanged() { userMoved = false }

    public var selectedIndex: Int? { selectedID.flatMap { id in results.firstIndex { $0.id == id } } }
    public var selected: ResultVM? { selectedIndex.map { results[$0] } }

    public mutating func apply(_ new: [ResultVM], resetSelection: Bool = false) {
        results = new
        if !resetSelection, userMoved, let id = selectedID, new.contains(where: { $0.id == id }) { return }
        selectedID = new.first?.id
    }

    public mutating func move(_ delta: Int) {
        guard !results.isEmpty else { return }
        let i = (selectedIndex ?? 0) + delta
        selectedID = results[max(0, min(results.count - 1, i))].id
        userMoved = true
    }

    /// Selects a row directly (a click): counts as moving the selection.
    public mutating func select(id: String) {
        guard results.contains(where: { $0.id == id }) else { return }
        selectedID = id
        userMoved = true
    }
}
