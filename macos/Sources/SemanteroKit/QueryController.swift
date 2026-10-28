import Foundation

public enum SemanticState: Sendable, Equatable {
    case notRun            // the query is too short to embed
    case pending           // keyword results shown, semantic on its way
    case merged            // semantic results merged in
    case off(String)       // why semantic search is off (Ollama or the pplx service unreachable, no vectors, ...)
}

public struct QueryUpdate: Sendable, Equatable {
    public let seq: Int
    public let query: String
    public let scope: Scope
    public let results: [ResultVM]
    public let semantic: SemanticState
}

/// The query as it is embedded (`semanticText` in rank.ts): surrounding whitespace dropped and runs of whitespace made
/// one space, so a trailing or doubled space gives the same vector.
public func semanticText(_ query: String) -> String {
    query.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

/// Turns keystrokes into result updates: keyword results immediately, semantic results after a pause, and stale
/// responses dropped by sequence number.
public actor QueryController {
    private let ranker: Ranker
    private let sleeper: Sleeper
    private let debounce: Double
    private var limit: Int
    private var embedder: (@Sendable (String) async throws -> [Float])?
    private var rowScorer: (@Sendable (String, Scope) async throws -> RowScores)?
    private var unreachable = "Ollama not reachable"
    private var warm: (@Sendable () async -> Void)?
    private var semanticAvailable = true
    private var semanticOffReason: String?
    private var onUpdate: @Sendable (QueryUpdate) -> Void

    private var seq = 0
    private var query = ""
    private var scope: Scope
    private var semanticTask: Task<Void, Never>?
    private var lastUpdate: QueryUpdate?
    /// Every keyword and semantic phase still running, so `settle()` can wait for them. Each removes itself when done.
    private var inFlight: [UUID: Task<Void, Never>] = [:]

    public init(ranker: Ranker, sleeper: Sleeper = SystemSleeper(), debounce: Double = 0.2, limit: Int = 15,
                scope: Scope = .all, onUpdate: @escaping @Sendable (QueryUpdate) -> Void) {
        self.ranker = ranker; self.sleeper = sleeper; self.debounce = debounce; self.limit = limit
        self.scope = scope; self.onUpdate = onUpdate
    }

    /// Configure query embedding after an index (re)load; nil disables semantic search with a reason.
    public func configure(embedder: (@Sendable (String) async throws -> [Float])?, warmUp: (@Sendable () async -> Void)? = nil,
                          offReason: String? = nil) {
        self.embedder = embedder
        self.rowScorer = nil
        self.unreachable = "Ollama not reachable"
        self.warm = warmUp
        semanticAvailable = embedder != nil
        semanticOffReason = embedder == nil ? (offReason ?? "semantic search is off") : nil
    }

    /// Configure semantic search by row scores from a service (the pplx profile: late interaction has no query vector).
    public func configure(rowScorer: @escaping @Sendable (String, Scope) async throws -> RowScores,
                          warmUp: (@Sendable () async -> Void)? = nil, unreachable: String) {
        self.embedder = nil
        self.rowScorer = rowScorer
        self.unreachable = unreachable
        self.warm = warmUp
        semanticAvailable = true
        semanticOffReason = nil
    }

    public func panelOpened() async { await warm?() }

    public func setScope(_ new: Scope) { scope = new; run() }
    /// Applies a new result limit and re-runs the current query.
    public func setLimit(_ new: Int) { limit = max(1, new); run() }
    /// A new query. Typing or deleting whitespace cannot change the results, so it keeps the list on screen (and any
    /// semantic merge on its way) instead of flashing back to keyword-only results until the merge lands again.
    /// `force` ranks it again anyway (the index was reloaded, or the recent notes may have changed); a merged list
    /// then stays on screen until the new merge replaces it, rather than flashing keyword-only results in between.
    public func setQuery(_ text: String, force: Bool = false) {
        let sameResults = semanticText(text) == semanticText(query)
        query = text
        if sameResults, let last = lastUpdate, last.seq == seq, last.scope == scope {
            if !force {
                publish(QueryUpdate(seq: seq, query: text, scope: last.scope, results: last.results, semantic: last.semantic))
                return
            }
            run(keepMerged: last.semantic == .merged)
            return
        }
        run()
    }

    private func run(keepMerged: Bool = false) {
        seq += 1
        let mySeq = seq, q = query, s = scope
        semanticTask?.cancel()
        semanticTask = nil
        track { await $0.keywordPhase(seq: mySeq, query: q, scope: s, keepMerged: keepMerged) }
    }

    /// Starts `work` and keeps its handle until it finishes.
    @discardableResult
    private func track(_ work: @escaping @Sendable (QueryController) async -> Void) -> Task<Void, Never> {
        let id = UUID()
        let task = Task { await work(self); self.finished(id) }
        inFlight[id] = task
        return task
    }
    private func finished(_ id: UUID) { inFlight[id] = nil }

    /// Tests: returns once every phase started so far (and any it starts) has finished, so "no further update arrives"
    /// can be checked without a guessed sleep. A semantic phase waiting on its debounce counts as running: release or
    /// cancel the sleeper first.
    func settle() async {
        while let task = inFlight.values.first { await task.value }
    }

    /// Updates carry the query as it is typed now: a whitespace-only edit since this request started kept its `seq`.
    private func publish(_ update: QueryUpdate) {
        lastUpdate = update
        onUpdate(update)
    }

    private func keywordPhase(seq mySeq: Int, query q: String, scope s: Scope, keepMerged: Bool) async {
        let kw = (try? await ranker.keyword(q, scope: s, limit: limit)) ?? []
        guard mySeq == seq else { return }
        var wantsSemantic = false
        if !q.trimmingCharacters(in: .whitespaces).isEmpty { wantsSemantic = await ranker.shouldRunSemantic(q) }
        guard mySeq == seq else { return }
        let state: SemanticState = !wantsSemantic ? .notRun : (semanticAvailable ? .pending : .off(semanticOffReason ?? ""))
        if !(keepMerged && state == .pending) {
            publish(QueryUpdate(seq: mySeq, query: query, scope: s, results: kw, semantic: state))
        }
        guard wantsSemantic, semanticAvailable else { return }
        semanticTask = track { await $0.semanticPhase(seq: mySeq, query: q, scope: s, keyword: kw) }
    }

    private func semanticPhase(seq mySeq: Int, query q: String, scope s: Scope, keyword kw: [ResultVM]) async {
        do { try await sleeper.sleep(seconds: debounce) } catch { return }
        guard mySeq == seq, embedder != nil || rowScorer != nil else { return }
        let text = semanticText(q)
        do {
            let merged: [ResultVM]
            if let rowScorer {
                let scores = try await rowScorer(text, s)
                guard mySeq == seq else { return }
                merged = try await ranker.hybridFromRowScores(q, papersScores: scores.papers, notesScores: scores.notes,
                                                              scope: s, limit: limit)
            } else {
                let vector = try await embedder!(text)
                guard mySeq == seq else { return }
                merged = try await ranker.hybrid(q, queryVector: vector, scope: s, limit: limit)
            }
            guard mySeq == seq else { return }
            publish(QueryUpdate(seq: mySeq, query: query, scope: s, results: merged, semantic: .merged))
        } catch {
            guard mySeq == seq else { return }
            publish(QueryUpdate(seq: mySeq, query: query, scope: s, results: kw, semantic: .off(unreachable)))
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

    public mutating func apply(_ new: [ResultVM]) {
        results = new
        if userMoved, let id = selectedID, new.contains(where: { $0.id == id }) { return }
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
