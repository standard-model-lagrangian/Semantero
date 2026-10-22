import Foundation
import Testing
@testable import DaitoSearchKit

private func controller(_ ranker: FakeRanker, sleeper: FakeSleeper, log: UpdateLog,
                        embedder: (@Sendable (String) async throws -> [Float])? = { _ in [1, 0] }) async -> QueryController {
    let c = QueryController(ranker: ranker, sleeper: sleeper, debounce: 0.2, limit: 15) { log.add($0) }
    await c.configure(embedder: embedder, offReason: "no vectors")
    return c
}

@Suite("QueryController")
struct QueryControllerTests {
    // S17
    @Test func keystrokePublishesKeywordResultsImmediately() async {
        let ranker = FakeRanker(), sleeper = FakeSleeper(), log = UpdateLog()
        let c = await controller(ranker, sleeper: sleeper, log: log)
        await c.setQuery("stiff")
        await log.wait { !$0.isEmpty }
        #expect(log.all.first?.results.map(\.id) == ["K:stiff"])
        #expect(log.all.first?.semantic == .notRun)
        #expect(ranker.hybridCalls.isEmpty)
    }

    // S18
    @Test func semanticRunsOnlyAfterTheDebounceAndOnlyWhenTheRuleSaysSo() async {
        let ranker = FakeRanker(), sleeper = FakeSleeper(), log = UpdateLog()
        let c = await controller(ranker, sleeper: sleeper, log: log)
        await c.setQuery("vis")
        await log.wait { $0.count >= 1 }
        #expect(log.all.last?.semantic == .notRun)
        #expect(sleeper.pending == 0)

        await c.setQuery("stiff gels ")
        await log.wait { $0.last?.query == "stiff gels " }
        #expect(log.all.last?.semantic == .pending)
        let waited = await Task { () -> Bool in
            for _ in 0..<200 { if sleeper.pending == 1 { return true }; try? await Task.sleep(nanoseconds: 2_000_000) }
            return false
        }.value
        #expect(waited, "semantic should be waiting on the debounce")
        #expect(ranker.hybridCalls.isEmpty)
        sleeper.releaseAll()
        await log.wait { $0.last?.semantic == .merged }
        #expect(log.all.last?.results.map(\.id) == ["H:stiff gels "])
        #expect(sleeper.requested.last == 0.2)
    }

    // S19
    @Test func staleSemanticResponseIsDropped() async {
        let ranker = FakeRanker(), sleeper = FakeSleeper(immediate: true), log = UpdateLog()
        let gate = AsyncGate()
        ranker.hybridDelay = { q in if q == "first query here" { await gate.wait() } }
        let c = await controller(ranker, sleeper: sleeper, log: log)
        await c.setQuery("first query here")
        await log.wait { $0.contains { $0.query == "first query here" } }
        await ranker.waitForHybrid("first query here")
        await c.setQuery("second query here")
        await log.wait { $0.contains { $0.query == "second query here" && $0.semantic == .merged } }
        await gate.open()                                   // the first request now resolves, late
        try? await Task.sleep(nanoseconds: 60_000_000)
        #expect(!log.all.contains { $0.query == "first query here" && $0.semantic == .merged })
        #expect(log.all.last?.query == "second query here")
        #expect(log.all.map(\.seq) == log.all.map(\.seq).sorted(), "updates never go backwards")
    }

    @Test func ollamaFailureKeepsKeywordResultsAndSaysWhySemanticIsOff() async {
        let ranker = FakeRanker(), sleeper = FakeSleeper(immediate: true), log = UpdateLog()
        let c = await controller(ranker, sleeper: sleeper, log: log) { _ in throw URLError(.cannotConnectToHost) }
        await c.setQuery("stiff gels ")
        await log.wait { $0.last?.semantic == .off("Ollama not reachable") }
        #expect(log.all.last?.results.map(\.id) == ["K:stiff gels "])
    }

    @Test func noEmbedderMeansOffFromTheStart() async {
        let ranker = FakeRanker(), sleeper = FakeSleeper(immediate: true), log = UpdateLog()
        let c = await controller(ranker, sleeper: sleeper, log: log, embedder: nil)
        await c.setQuery("stiff gels ")
        await log.wait { !$0.isEmpty }
        #expect(log.all.first?.semantic == .off("no vectors"))
        #expect(ranker.hybridCalls.isEmpty)
    }

    // S21
    @Test func scopeChangeRequeriesAndIsRemembered() async throws {
        let ranker = FakeRanker(), sleeper = FakeSleeper(), log = UpdateLog()
        let c = await controller(ranker, sleeper: sleeper, log: log)
        await c.setQuery("organoid")
        await log.wait { $0.count == 1 }
        await c.setScope(.notes)
        await log.wait { $0.count == 2 }
        #expect(log.all.last?.scope == .notes)
        #expect(ranker.scopes == [.all, .notes])

        let suite = try #require(UserDefaults(suiteName: "daito-test-\(UUID().uuidString)"))
        let settings = SettingsStore(defaults: suite)
        #expect(settings.scope == .all)
        settings.scope = .papers
        #expect(SettingsStore(defaults: suite).scope == .papers)
    }

    @Test func panelOpenedRunsTheWarmUp() async {
        let ranker = FakeRanker(), log = UpdateLog(), warmed = CallLog()
        let c = QueryController(ranker: ranker) { log.add($0) }
        await c.configure(embedder: { _ in [] }, warmUp: { warmed.add("warm") })
        await c.panelOpened()
        #expect(warmed.all == ["warm"])
    }

    // S20
    @Test func selectionStaysOnTheSameIDAfterAReRank() {
        var s = SelectionModel()
        s.apply([vm("a"), vm("b"), vm("c")])
        #expect(s.selectedID == "a")
        s.move(1); s.move(1)
        #expect(s.selectedID == "c")
        s.apply([vm("c"), vm("a"), vm("x")])                 // re-ranked: c is still listed
        #expect(s.selectedID == "c" && s.selectedIndex == 0)
        s.apply([vm("a"), vm("b")])                          // c vanished: back to the top
        #expect(s.selectedID == "a")
        s.move(-5); #expect(s.selectedID == "a")
        s.move(9); #expect(s.selectedID == "b")
        s.apply([vm("b")], resetSelection: true); #expect(s.selectedID == "b")
        s.apply([]); #expect(s.selectedID == nil && s.selected == nil)
    }

    @Test func untouchedSelectionFollowsTheNewTopResult() {
        var s = SelectionModel()
        s.apply([vm("a"), vm("b"), vm("c")])          // keyword results
        s.apply([vm("c"), vm("a"), vm("b")])          // semantic re-rank: ↵ should open the new best match
        #expect(s.selectedID == "c")
        s.move(1)
        s.apply([vm("b"), vm("a"), vm("c")])          // moved by the user: stays on "a"
        #expect(s.selectedID == "a")
        s.queryChanged()
        s.apply([vm("x"), vm("a")])                   // a new query: back to following the top
        #expect(s.selectedID == "x")
        s.select(id: "a")
        s.apply([vm("y"), vm("a")])
        #expect(s.selectedID == "a")                  // a click counts as moving
        s.select(id: "nope")
        #expect(s.selectedID == "a")
    }

    @Test func selectionNeverJumpsAcrossRandomisedReRanks() {
        var s = SelectionModel()
        var rng = SystemRandomNumberGenerator()
        let ids = (0..<30).map { "id\($0)" }
        s.apply(ids.map { vm($0) })
        s.move(3)
        for _ in 0..<1000 {
            let before = s.selectedID
            let next = ids.shuffled(using: &rng).prefix(Int.random(in: 5...30, using: &rng)).map { vm($0) }
            s.apply(Array(next))
            if let before, next.contains(where: { $0.id == before }) { #expect(s.selectedID == before) }
        }
    }
}

actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async { if isOpen { return }; await withCheckedContinuation { waiters.append($0) } }
    func open() { isOpen = true; waiters.forEach { $0.resume() }; waiters = [] }
}

extension FakeRanker {
    func waitForHybrid(_ q: String) async {
        for _ in 0..<500 { if hybridCalls.contains(q) { return }; try? await Task.sleep(nanoseconds: 2_000_000) }
    }
}
