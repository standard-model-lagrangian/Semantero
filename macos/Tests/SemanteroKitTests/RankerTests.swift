import Foundation
import Testing
@testable import SemanteroKit

struct ConformanceCase: Decodable {
    let name: String
    let mode: String
    let query: String
    let scope: Scope
    let limit: Int
    let qVec: [Float]?
    let expect: [ResultVM]
}

private func loadCases() throws -> [ConformanceCase] {
    struct File: Decodable { let cases: [ConformanceCase] }
    return try JSONDecoder().decode(File.self, from: Data(contentsOf: Repo.cases)).cases
}

private func run(_ c: ConformanceCase, on ranker: Ranker) async throws -> [ResultVM] {
    switch c.mode {
    case "recent": return try await ranker.recent(limit: c.limit)
    case "hybrid": return try await ranker.hybrid(c.query, queryVector: try #require(c.qVec), scope: c.scope, limit: c.limit)
    default: return try await ranker.keyword(c.query, scope: c.scope, limit: c.limit)
    }
}

@Suite("Ranker")
struct RankerTests {
    // S5
    @Test func jscRankerPassesEveryConformanceCase() async throws {
        let ranker = try await loadedJSCRanker()
        let cases = try loadCases()
        #expect(cases.count >= 60)
        var failures: [String] = []
        for c in cases {
            let got = try await run(c, on: ranker)
            if got != c.expect { failures.append(c.name) }
        }
        #expect(failures.isEmpty, "conformance failures: \(failures)")
    }

    // S6
    @Test func acceleratedRankerPassesEveryConformanceCase() async throws {
        let jsc = try makeJSCRanker()
        let ranker = AcceleratedRanker(inner: jsc)
        let f = try fixtureFiles()
        _ = try await ranker.load(papers: f.papers, notes: f.notes)
        var failures: [String] = []
        for c in try loadCases() {
            let got = try await run(c, on: ranker)
            if got != c.expect { failures.append(c.name) }
        }
        #expect(failures.isEmpty, "conformance failures (Accelerate): \(failures)")
    }

    // S8
    @Test func jsExceptionBecomesRankerErrorAndKeepsPreviousEngine() async throws {
        let ranker = try await loadedJSCRanker()
        let before = try await ranker.keyword("matrigel", scope: .all, limit: 3)
        #expect(!before.isEmpty)
        let f = try fixtureFiles()
        let bad = CorpusFiles(dir: f.papers.dir, manifest: Data("{not json".utf8), papers: f.papers.papers, chunks: f.papers.chunks,
                              vectors: f.papers.vectors, contentHash: "x")
        do {
            _ = try await ranker.load(papers: bad, notes: nil)
            Issue.record("load should have thrown")
        } catch let e as RankerError {
            #expect(!e.message.isEmpty)
        }
        #expect(try await ranker.keyword("matrigel", scope: .all, limit: 3) == before)
    }

    @Test func callsBeforeLoadThrowInsteadOfCrashing() async throws {
        let ranker = try makeJSCRanker()
        await #expect(throws: RankerError.self) { _ = try await ranker.keyword("x", scope: .all, limit: 1) }
    }

    // S9
    @Test func versionMismatchIsAnErrorState() async throws {
        let ranker = try makeJSCRanker(version: "9.9.9")
        let f = try fixtureFiles()
        do {
            _ = try await ranker.load(papers: f.papers, notes: f.notes)
            Issue.record("expected a version error")
        } catch let e as RankerError {
            #expect(e.message.contains("version"))
        }
        await #expect(throws: RankerError.self) { _ = try await ranker.keyword("x", scope: .all, limit: 1) }
    }

    // S10
    @Test func actorSerialisesHundredConcurrentCalls() async throws {
        let ranker = try await loadedJSCRanker()
        let expected = try await ranker.keyword("stress relaxation", scope: .all, limit: 5)
        let results = try await withThrowingTaskGroup(of: [ResultVM].self) { group in
            for i in 0..<100 {
                group.addTask { i % 2 == 0 ? try await ranker.keyword("stress relaxation", scope: .all, limit: 5)
                                           : try await ranker.recent(limit: 3).isEmpty ? [] : expected }
            }
            return try await group.reduce(into: []) { $0.append($1) }
        }
        #expect(results.count == 100)
        #expect(results.allSatisfy { $0 == expected })
    }

    @Test func statusReportsModelDimsAndInstruction() async throws {
        let s = try await loadedJSCRanker().status()
        #expect(s.dims == 8)
        #expect(s.model == "qwen3-embedding:0.6b")
        #expect(s.queryInstruction?.contains("retrieve that paper") == true)
        #expect(s.papers?.count == 4 && s.notes?.count == 7)
        #expect(s.anySemantic)
    }

    @Test func shouldRunSemanticUsesTheTypeScriptRule() async throws {
        let r = try await loadedJSCRanker()
        #expect(await r.shouldRunSemantic("vis") == false)
        #expect(await r.shouldRunSemantic("stiff gels ") == true)
        #expect(await r.shouldRunSemantic("viscoelasticit") == true)
        // a trailing space never changes the answer
        #expect(await r.shouldRunSemantic("neural stem") == true)
        #expect(await r.shouldRunSemantic("neural stem ") == true)
        #expect(await r.shouldRunSemantic("stiff g") == false)
        #expect(await r.shouldRunSemantic("stiff g ") == false)
    }

    @Test func lookupResolvesIds() async throws {
        let r = try await loadedJSCRanker()
        let out = try await r.lookup(ids: ["P:KEY0001", "P:NOPE"])
        #expect(out.map(\.id) == ["P:KEY0001"])
    }

    // S11
    @Test func vectorScorerEqualsNaiveReference() throws {
        let dims = 16, rows = 200
        var rng = SystemRandomNumberGenerator()
        var floats = [Float](); for _ in 0..<(rows * dims) { floats.append(Float.random(in: -1...1, using: &rng)) }
        let query = (0..<dims).map { _ in Float.random(in: -1...1, using: &rng) }
        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        let got = try #require(VectorScorer.rowScores(vectors: data, dims: dims, query: query))
        #expect(got.count == rows)
        for r in 0..<rows {
            var ref = 0.0
            for d in 0..<dims { ref += Double(floats[r * dims + d]) * Double(query[d]) }
            #expect(abs(Double(got[r]) - ref) < 1e-5)
        }
    }

    // S12
    @Test func vectorScorerWithWrongDimsOrEmptyReturnsNil() {
        let data = Data(count: 8 * 4 * 5)
        #expect(VectorScorer.rowScores(vectors: data, dims: 8, query: [1, 2, 3]) == nil)
        #expect(VectorScorer.rowScores(vectors: data, dims: 0, query: []) == nil)
        #expect(VectorScorer.rowScores(vectors: Data(), dims: 8, query: [Float](repeating: 0, count: 8)) == nil)
        #expect(VectorScorer.rowScores(vectors: Data(count: 7), dims: 8, query: [Float](repeating: 0, count: 8)) == nil)
    }
}
