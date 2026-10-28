import Accelerate
import Foundation

/// Option B of the ranker decision: the dot product of the query with every row, natively (`vDSP_mmul`, a matrix-vector product), over the
/// memory-mapped `vectors.f32`. The TypeScript side then does the per-paper maximum, snippets and view models.
public enum VectorScorer {
    /// Float32 scores, one per row, or nil when the query's dimensions do not match or there is nothing to score.
    public static func rowScores(vectors: Data, dims: Int, query: [Float]) -> [Float]? {
        guard dims > 0, query.count == dims, vectors.count % (dims * 4) == 0 else { return nil }
        let rows = vectors.count / (dims * 4)
        guard rows > 0 else { return nil }
        var out = [Float](repeating: 0, count: rows)
        vectors.withUnsafeBytes { raw in
            let base = raw.baseAddress!.assumingMemoryBound(to: Float.self)
            // out (rows x 1) = vectors (rows x dims) * query (dims x 1)
            vDSP_mmul(base, 1, query, 1, &out, 1, vDSP_Length(rows), 1, vDSP_Length(dims))
        }
        return out
    }

    public static func scoresData(_ scores: [Float]) -> Data {
        scores.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}

/// JavaScriptCore for everything except the vector pass, which uses Accelerate.
public actor AcceleratedRanker: NotesReloading {
    private let inner: JSCRanker
    private var vectors: [Scope: Data] = [:]
    private var lastStatus: RankerStatus?

    public init(inner: JSCRanker) { self.inner = inner }

    public func load(papers: CorpusFiles?, notes: CorpusFiles?) async throws -> RankerStatus {
        let status = try await inner.load(papers: papers, notes: notes)
        vectors = [:]
        if let v = papers?.vectors { vectors[.papers] = v }
        if let v = notes?.vectors { vectors[.notes] = v }
        lastStatus = status
        return status
    }

    public func reloadNotes(_ notes: CorpusFiles?) async throws -> RankerStatus {
        let status = try await inner.reloadNotes(notes)
        vectors[.notes] = notes?.vectors
        lastStatus = status
        return status
    }

    public func collectGarbage() async { await inner.collectGarbage() }

    public func shouldRunSemantic(_ query: String) async -> Bool { await inner.shouldRunSemantic(query) }
    public func keyword(_ query: String, scope: Scope, limit: Int) async throws -> [ResultVM] {
        try await inner.keyword(query, scope: scope, limit: limit)
    }
    public func recent(limit: Int) async throws -> [ResultVM] { try await inner.recent(limit: limit) }

    public func hybridFromRowScores(_ query: String, papersScores: Data?, notesScores: Data?, scope: Scope,
                                    limit: Int) async throws -> [ResultVM] {
        try await inner.hybridFromRowScores(query, papersScores: papersScores, notesScores: notesScores, scope: scope, limit: limit)
    }

    public func hybrid(_ query: String, queryVector: [Float], scope: Scope, limit: Int) async throws -> [ResultVM] {
        guard let status = lastStatus, let dims = status.dims else {
            return try await inner.keyword(query, scope: scope, limit: limit)
        }
        func scores(_ corpus: Scope, _ cs: CorpusStatus?) -> Data? {
            guard scope == .all || scope == corpus, cs?.semantic == true, let v = vectors[corpus],
                  let s = VectorScorer.rowScores(vectors: v, dims: dims, query: queryVector) else { return nil }
            return VectorScorer.scoresData(s)
        }
        return try await inner.hybridFromRowScores(
            query, papersScores: scores(.papers, status.papers), notesScores: scores(.notes, status.notes),
            scope: scope, limit: limit)
    }
}
