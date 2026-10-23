import Foundation
import Testing
@testable import DaitoSearchKit

private func scoresJSON(_ corpora: [String: [String: Any]]) -> Data {
    try! JSONSerialization.data(withJSONObject: ["model": "pplx", "corpora": corpora])
}

private func b64(_ f: [Float]) -> String { f.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString() }

private func client(_ t: FakeTransport, hashes: [Scope: String] = [.papers: "hp", .notes: "hn"]) -> PplxClient {
    PplxClient(baseURL: URL(string: "http://127.0.0.1:11435")!, expectedHashes: hashes, transport: t)
}

@Suite("PplxClient")
struct PplxTests {
    @Test func asksForTheScopesCorporaAndReturnsTheirFloat32Scores() async throws {
        let t = FakeTransport()
        t.response = { body in
            let wanted = body["corpora"] as? [String] ?? []
            var out: [String: [String: Any]] = [:]
            if wanted.contains("search") { out["search"] = ["content_hash": "hp", "scores": b64([0.5, 0.25])] }
            if wanted.contains("notes") { out["notes"] = ["content_hash": "hn", "scores": b64([1])] }
            return (scoresJSON(out), 200)
        }
        let all = try await client(t).rowScores("stiff gels", scope: .all)
        #expect(all.papers == [Float(0.5), 0.25].withUnsafeBufferPointer { Data(buffer: $0) })
        #expect(all.notes == [Float(1)].withUnsafeBufferPointer { Data(buffer: $0) })
        let r = try #require(t.requests.first)
        #expect(r.url.absoluteString == "http://127.0.0.1:11435/rowscores")
        #expect(r.body["text"] as? String == "stiff gels")
        #expect(r.body["corpora"] as? [String] == ["search", "notes"])

        let notes = try await client(t).rowScores("q", scope: .notes)
        #expect(t.requests.last?.body["corpora"] as? [String] == ["notes"])
        #expect(notes.papers == nil)
    }

    @Test func corporaWithoutVectorsAreNotRequested() async throws {
        let t = FakeTransport()
        t.response = { _ in (scoresJSON(["search": ["content_hash": "hp", "scores": b64([1])]]), 200) }
        let r = try await client(t, hashes: [.papers: "hp"]).rowScores("q", scope: .all)
        #expect(t.requests.first?.body["corpora"] as? [String] == ["search"])
        #expect(r.notes == nil)
        let none = try await client(t, hashes: [:]).rowScores("q", scope: .all)
        #expect(none == RowScores(papers: nil, notes: nil))
        #expect(t.requests.count == 1)
    }

    @Test func anotherBuildAnErrorOrAFailedRequestThrow() async {
        let t = FakeTransport()
        t.response = { _ in (scoresJSON(["search": ["content_hash": "old", "scores": b64([1])]]), 200) }
        await #expect(throws: PplxError.self) { try await client(t).rowScores("q", scope: .papers) }
        t.response = { _ in (scoresJSON(["search": ["error": "the live index is qwen3-embedding:0.6b"]]), 200) }
        await #expect(throws: PplxError(description: "pplx service: the live index is qwen3-embedding:0.6b")) {
            try await client(t).rowScores("q", scope: .papers)
        }
        t.response = { _ in (Data(), 500) }
        await #expect(throws: PplxError.self) { try await client(t).rowScores("q", scope: .papers) }
    }

    @Test func warmUpPostsToWarm() async {
        let t = FakeTransport()
        await client(t).warmUp()
        #expect(t.requests.first?.url.absoluteString == "http://127.0.0.1:11435/warm")
    }

    @Test func controllerMergesServiceScoresThroughTheRanker() async {
        let ranker = FakeRanker(), sleeper = FakeSleeper(immediate: true), log = UpdateLog()
        let c = QueryController(ranker: ranker, sleeper: sleeper, debounce: 0.2, limit: 15) { log.add($0) }
        let papers = Data([1, 2, 3, 4])
        await c.configure(rowScorer: { _, _ in RowScores(papers: papers, notes: nil) }, unreachable: "pplx service not reachable")
        await c.setQuery("stiff gels ")
        await log.wait { $0.last?.semantic == .merged }
        #expect(log.all.last?.results.map(\.id) == ["S:stiff gels "])
        #expect(ranker.rowScoreCalls.first?.papers == papers)
        #expect(ranker.hybridCalls.isEmpty)
    }

    @Test func controllerSaysTheServiceIsDownWhenItThrows() async {
        let ranker = FakeRanker(), sleeper = FakeSleeper(immediate: true), log = UpdateLog()
        let c = QueryController(ranker: ranker, sleeper: sleeper, debounce: 0.2, limit: 15) { log.add($0) }
        await c.configure(rowScorer: { _, _ in throw PplxError(description: "down") }, unreachable: "pplx service not reachable")
        await c.setQuery("stiff gels ")
        await log.wait { $0.last?.semantic == .off("pplx service not reachable") }
        #expect(log.all.last?.results.map(\.id) == ["K:stiff gels "])
    }

    @Test func spotlightUsesTheRowScorer() async {
        let ranker = FakeRanker()
        let svc = IntentSearchService(ranker: ranker, embedder: nil, rowScorer: { _, _ in RowScores(papers: Data([0, 0, 0, 0]), notes: nil) },
                                      sleeper: SystemSleeper(), semanticWait: 2)
        #expect(await svc.matching("stiff gels in organoids").map(\.id) == ["S:stiff gels in organoids"])
    }
}
