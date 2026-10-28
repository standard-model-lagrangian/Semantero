import Foundation

/// What the UI and the query controller need from a ranker. Every implementation (JavaScriptCore, JavaScriptCore +
/// Accelerate, a Swift port) must pass the conformance cases in launcher-core/conformance/cases.json.
public protocol Ranker: Sendable {
    /// Builds both corpora and swaps the engine in only on success; a failure keeps the previous engine.
    func load(papers: CorpusFiles?, notes: CorpusFiles?) async throws -> RankerStatus
    func shouldRunSemantic(_ query: String) async -> Bool
    func keyword(_ query: String, scope: Scope, limit: Int) async throws -> [ResultVM]
    func hybrid(_ query: String, queryVector: [Float], scope: Scope, limit: Int) async throws -> [ResultVM]
    /// Hybrid from Float32 row scores computed elsewhere (Accelerate, or the pplx service for a late-interaction index).
    func hybridFromRowScores(_ query: String, papersScores: Data?, notesScores: Data?, scope: Scope,
                             limit: Int) async throws -> [ResultVM]
    /// Recent notes (the conformance cases' "recent" mode; the panel's empty query goes through `keyword`).
    func recent(limit: Int) async throws -> [ResultVM]
    /// Reclaim what the last load left behind (see JSCRanker.collectGarbage).
    func collectGarbage() async
}

public extension Ranker {
    /// Rankers without a row-score path rank by keyword.
    func hybridFromRowScores(_ query: String, papersScores: Data?, notesScores: Data?, scope: Scope,
                             limit: Int) async throws -> [ResultVM] {
        try await keyword(query, scope: scope, limit: limit)
    }

    /// Rankers without a JavaScript heap have nothing to collect.
    func collectGarbage() async {}
}

/// A ranker that can replace only the notes corpus, reusing the loaded papers corpus. Used when only the notes index
/// changed (the common case while writing): no re-read or rebuild of the much larger paper index.
public protocol NotesReloading: Ranker {
    func reloadNotes(_ notes: CorpusFiles?) async throws -> RankerStatus
}
