import Foundation
import Testing
@testable import DaitoSearchKit

@Suite("Spotlight action (intent logic)")
struct IntentTests {
    // S39
    @Test func entityQueryReturnsAtMostTenInRankerOrder() async {
        let ranker = FakeRanker()
        ranker.keywordResults = { _, _ in (0..<14).map { vm("K\($0)") } }
        let service = IntentSearchService(ranker: ranker, embedder: nil, sleeper: FakeSleeper(immediate: true))
        let out = await service.matching("organoid")
        // the ranker is asked for 10; the fake ignores the limit, so only check the order it keeps
        #expect(out.prefix(3).map(\.id) == ["K0", "K1", "K2"])
    }

    @Test func hybridResultsAreUsedWhenTheVectorArrivesInTime() async {
        let ranker = FakeRanker()
        let service = IntentSearchService(ranker: ranker, embedder: { _ in [1, 0] }, sleeper: FakeSleeper())
        let out = await service.matching("stiff gels promoted")
        #expect(out.map(\.id) == ["H:stiff gels promoted"])
    }

    // S40
    @Test func emptyStringSuggestsTheRecentResults() async {
        let ranker = FakeRanker()
        let service = IntentSearchService(ranker: ranker, embedder: nil)
        #expect(await service.matching("   ").map(\.id) == (0..<10).map { "R\($0)" })
        #expect(await service.suggested().count == 10)
    }

    // S41
    @Test func engineNotLoadedGivesEmptyNotACrash() async {
        let ranker = FakeRanker()
        ranker.notLoaded = true
        let service = IntentSearchService(ranker: ranker, embedder: { _ in [1] }, sleeper: FakeSleeper(immediate: true))
        #expect(await service.matching("anything at all here").isEmpty)
        #expect(await service.suggested().isEmpty)
        #expect(await service.results(for: ["P:1"]).isEmpty)
    }

    // S42
    @Test func semanticWaitIsCappedAndThenKeywordResultsAreReturned() async {
        let ranker = FakeRanker()
        let sleeper = FakeSleeper()                      // the 0.4 s cap timer: we fire it by hand
        let neverEmbeds: @Sendable (String) async throws -> [Float] = { _ in
            try await Task.sleep(nanoseconds: 30_000_000_000)
            return [1]
        }
        let service = IntentSearchService(ranker: ranker, embedder: neverEmbeds, sleeper: sleeper)
        async let result = service.matching("stiff gels promoted")
        for _ in 0..<500 { if sleeper.pending == 1 { break }; try? await Task.sleep(nanoseconds: 2_000_000) }
        #expect(sleeper.requested == [0.4])
        sleeper.releaseAll()                             // the cap expires
        let out = await result
        #expect(out.map(\.id) == ["K:stiff gels promoted"])
        #expect(ranker.hybridCalls.isEmpty)
    }

    @Test func embeddingFailureFallsBackToKeywordImmediately() async {
        let ranker = FakeRanker()
        let service = IntentSearchService(ranker: ranker, embedder: { _ in throw URLError(.cannotConnectToHost) }, sleeper: FakeSleeper())
        #expect(await service.matching("stiff gels promoted").map(\.id) == ["K:stiff gels promoted"])
    }

    @Test func resultsForIdsComeFromTheEngine() async {
        let ranker = FakeRanker()
        ranker.lookupResults = ["P:1": vm("P:1"), "N:2": vm("N:2")]
        let service = IntentSearchService(ranker: ranker, embedder: nil)
        #expect(await service.results(for: ["N:2", "P:1", "P:zzz"]).map(\.id) == ["N:2", "P:1"])
    }
}
