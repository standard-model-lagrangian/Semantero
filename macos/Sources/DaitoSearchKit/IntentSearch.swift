import Foundation

/// The logic behind the Spotlight action ("Search Everything"): what to return for the text typed after Tab, what to
/// suggest before anything is typed, and how to resolve remembered ids. The App Intents types in the app target are
/// thin wrappers around this.
public actor IntentSearchService {
    public static let maxResults = 10

    private let ranker: Ranker
    private let embedder: (@Sendable (String) async throws -> [Float])?
    private let sleeper: Sleeper
    private let semanticWait: Double

    public init(ranker: Ranker, embedder: (@Sendable (String) async throws -> [Float])?, sleeper: Sleeper = SystemSleeper(),
                semanticWait: Double = 0.4) {
        self.ranker = ranker; self.embedder = embedder; self.sleeper = sleeper; self.semanticWait = semanticWait
    }

    /// Hybrid results, but never wait longer than `semanticWait` seconds for the query vector: after that, keyword
    /// results are returned. An engine that is not loaded yet gives [] (never a crash).
    public func matching(_ query: String) async -> [ResultVM] {
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return await suggested() }
        let keyword = (try? await ranker.keyword(q, scope: .all, limit: Self.maxResults)) ?? []
        guard let embedder, await ranker.shouldRunSemantic(q) else { return keyword }
        let ranker = self.ranker, sleeper = self.sleeper, wait = semanticWait
        enum Race: Sendable { case semantic([ResultVM]?), timeout }
        return await withTaskGroup(of: Race.self) { group in
            group.addTask {
                guard let v = try? await embedder(q) else { return .semantic(nil) }
                return .semantic(try? await ranker.hybrid(q, queryVector: v, scope: .all, limit: Self.maxResults))
            }
            group.addTask { try? await sleeper.sleep(seconds: wait); return .timeout }
            let first = await group.next()
            group.cancelAll()
            if case .semantic(let results?)? = first { return results }
            return keyword   // timed out, or the embedding/hybrid call failed
        }
    }

    public func suggested() async -> [ResultVM] {
        (try? await ranker.recent(limit: Self.maxResults)) ?? []
    }

    public func results(for ids: [String]) async -> [ResultVM] {
        (try? await ranker.lookup(ids: ids)) ?? []
    }
}

/// A Spotlight result (Core Spotlight item or intent entity) reaches the app as an id; this resolves it against the
/// current engine and runs the `↵` action.
public struct SpotlightOpenService: Sendable {
    private let ranker: Ranker
    private let executor: ActionExecutor

    public init(ranker: Ranker, executor: ActionExecutor) { self.ranker = ranker; self.executor = executor }

    public func open(identifier: String) async -> ActionOutcome {
        guard let vm = try? await ranker.lookup(ids: [identifier]).first else { return .failed("Result not found: \(identifier)") }
        return await executor.run("open", on: vm)
    }
}
