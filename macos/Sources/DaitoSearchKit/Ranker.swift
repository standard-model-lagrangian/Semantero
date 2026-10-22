import Foundation

/// What the UI and the query controller need from a ranker. Every implementation (JavaScriptCore, JavaScriptCore +
/// Accelerate, a Swift port) must pass the conformance cases in launcher-core/conformance/cases.json.
public protocol Ranker: Sendable {
    /// Builds both corpora and swaps the engine in only on success; a failure keeps the previous engine.
    func load(papers: CorpusFiles?, notes: CorpusFiles?) async throws -> RankerStatus
    func status() async throws -> RankerStatus
    func shouldRunSemantic(_ query: String) async -> Bool
    func keyword(_ query: String, scope: Scope, limit: Int) async throws -> [ResultVM]
    func hybrid(_ query: String, queryVector: [Float], scope: Scope, limit: Int) async throws -> [ResultVM]
    func recent(limit: Int) async throws -> [ResultVM]
    /// Results for remembered ids (Spotlight), in the order asked; unknown ids are skipped.
    func lookup(ids: [String]) async throws -> [ResultVM]
}
