import Foundation
import Synchronization
import Testing
@testable import SemanteroKit

private final class EventLog: Sendable {
    private let items = Mutex<[IndexEvent]>([])
    let signal = ChangeSignal()
    func add(_ e: IndexEvent) { items.withLock { $0.append(e) }; signal.changed() }
    var all: [IndexEvent] { items.withLock { $0 } }
}

/// A status as `JSCRanker.load` reports it for the fixtures (both corpora with vectors).
private let semanticStatus = RankerStatus(
    papers: CorpusStatus(count: 4, builtAt: "p", semantic: true, reason: nil),
    notes: CorpusStatus(count: 7, builtAt: "n", semantic: true, reason: nil),
    model: "qwen3-embedding:0.6b", dims: 8, queryInstruction: "Instruct")
private let keywordOnlyStatus = RankerStatus(
    papers: CorpusStatus(count: 4, builtAt: "p", semantic: false, reason: "no vectors"),
    notes: CorpusStatus(count: 7, builtAt: "n", semantic: false, reason: "no vectors"))

private func manifest(_ json: String) -> IndexManifest? { IndexManifest(data: Data(json.utf8)) }

@Suite("Index manifest")
struct IndexManifestTests {
    @Test func readsTheFieldsTheAppUses() throws {
        let m = try #require(manifest("""
            {"content_hash": "abc", "built_at": "2026-10-20", "backend": "pplx", "backend_url": "http://127.0.0.1:9", "zotero_storage": "/Z", "dims": 8}
            """))
        #expect(m == IndexManifest(contentHash: "abc", builtAt: "2026-10-20", backend: "pplx", backendURL: "http://127.0.0.1:9"))
        #expect(m.hash == "abc")
    }

    @Test func hashFallsBackToBuiltAtAndOddFieldsAreIgnored() throws {
        // A field of another type reads as absent (as the old `as? String` reads did), not as an unreadable manifest.
        let m = try #require(manifest(#"{"content_hash": 7, "built_at": "2026-10-20", "backend": null}"#))
        #expect(m.contentHash == nil && m.backend == nil)
        #expect(m.hash == "2026-10-20")
        #expect(manifest("{}")?.hash == nil)
    }

    @Test func missingOrBrokenManifestIsNil() throws {
        #expect(manifest("[1, 2]") == nil)
        #expect(manifest("{broken") == nil)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("semantero-manifest-\(UUID().uuidString)")
        #expect(IndexManifest.read(dir: dir) == nil)
        #expect(IndexManifest.read(dir: Repo.notesDir)?.hash == IndexFiles.manifestHash(of: Repo.notesDir))
        #expect(IndexManifest.read(dir: Repo.papersDir)?.hash == "2026-10-20T04:06")
    }
}

@Suite("Embedding choice")
struct EmbeddingChoiceTests {
    private let ollama = "http://127.0.0.1:11434"

    @Test func aPplxIndexUsesThePplxServiceWithTheHashesOfTheSemanticCorpora() {
        let papers = manifest(#"{"content_hash": "P1", "backend": "pplx", "backend_url": "http://127.0.0.1:9999"}"#)
        let notes = manifest(#"{"content_hash": "N1", "backend": "pplx"}"#)
        #expect(EmbeddingChoice.choose(status: semanticStatus, papers: papers, notes: notes, ollamaURL: ollama, keepAlive: "5m")
                == .pplx(baseURL: URL(string: "http://127.0.0.1:9999")!, expectedHashes: [.papers: "P1", .notes: "N1"]))
        // Notes without vectors are not scored by the service; the default URL is the service's.
        let papersOnly = RankerStatus(papers: semanticStatus.papers, notes: keywordOnlyStatus.notes)
        let defaultURL = manifest(#"{"content_hash": "P1", "backend": "pplx"}"#)
        #expect(EmbeddingChoice.choose(status: papersOnly, papers: defaultURL, notes: notes, ollamaURL: ollama, keepAlive: "5m")
                == .pplx(baseURL: URL(string: "http://127.0.0.1:11435")!, expectedHashes: [.papers: "P1"]))
    }

    @Test func theBackendCanComeFromTheNotesManifestAlone() {
        let notes = manifest(#"{"content_hash": "N1", "backend": "pplx"}"#)
        #expect(EmbeddingChoice.choose(status: semanticStatus, papers: nil, notes: notes, ollamaURL: ollama, keepAlive: "5m")
                == .pplx(baseURL: URL(string: "http://127.0.0.1:11435")!, expectedHashes: [.notes: "N1"]))
    }

    @Test func anIndexWithoutABackendUsesOllamaWithTheIndexModel() {
        let papers = manifest(#"{"content_hash": "P1"}"#)
        #expect(EmbeddingChoice.choose(status: semanticStatus, papers: papers, notes: nil, ollamaURL: ollama, keepAlive: "30m")
                == .ollama(baseURL: URL(string: ollama)!, model: "qwen3-embedding:0.6b", dims: 8, instruction: "Instruct",
                           keepAlive: "30m"))
    }

    @Test func noVectorsMeansOffEvenForAPplxIndex() {
        let pplx = manifest(#"{"content_hash": "P1", "backend": "pplx"}"#)
        #expect(EmbeddingChoice.choose(status: keywordOnlyStatus, papers: pplx, notes: pplx, ollamaURL: ollama, keepAlive: "5m")
                == .off("the index has no vectors"))
        #expect(EmbeddingChoice.choose(status: RankerStatus(), papers: nil, notes: nil, ollamaURL: ollama, keepAlive: "5m")
                == .off("the index has no vectors"))
    }

    @Test func anUnusableOllamaURLTurnsSemanticOffWithAReason() {
        #expect(EmbeddingChoice.choose(status: semanticStatus, papers: nil, notes: nil, ollamaURL: "", keepAlive: "5m")
                == .off("Ollama URL is invalid"))
    }

    @Test func aPplxIndexWithAnUnusableServiceURLFallsBackToOllama() {
        let papers = manifest(#"{"content_hash": "P1", "backend": "pplx", "backend_url": ""}"#)
        guard case .ollama = EmbeddingChoice.choose(status: semanticStatus, papers: papers, notes: nil, ollamaURL: ollama,
                                                    keepAlive: "5m") else { Issue.record("expected Ollama"); return }
    }
}

/// A coordinator over a temp copy of the fixture vault and a fake ranker; no file watcher.
@MainActor
private final class Harness {
    let vault: URL
    let ranker = FakeRanker()
    let sleeper = FakeSleeper()
    let updates = UpdateLog()
    let events = EventLog()
    let logged = CallLog()
    let scratch: ScratchDefaults
    let controller: QueryController
    var query = "stiff gels "
    var panelVisible = false
    var footprint = 100
    var now = Date(timeIntervalSince1970: 1_000_000)
    var coordinator: IndexCoordinator!

    init(_ name: String, status: RankerStatus = semanticStatus) throws {
        vault = try makeTempVault()
        scratch = ScratchDefaults("coordinator-\(name)")
        ranker.loadStatus = status
        let updates = self.updates
        controller = QueryController(ranker: ranker, sleeper: FakeSleeper()) { updates.add($0) }
        let events = self.events, logged = self.logged
        coordinator = IndexCoordinator(
            ranker: ranker, controller: controller, vault: vault, settings: SettingsStore(defaults: scratch.defaults), sleeper: sleeper,
            watchdog: MemoryWatchdog(thresholdMB: 350, minInterval: 600), watchFiles: false,
            hooks: IndexCoordinator.Hooks(
                // Weak: a poll still running when the test ends may outlive the harness.
                panelVisible: { [weak self] in self?.panelVisible ?? false }, query: { [weak self] in self?.query ?? "" },
                footprintMB: { [weak self] in self?.footprint ?? 0 }, now: { [weak self] in self?.now ?? Date() },
                log: { logged.add($0) }, onEvent: { events.add($0) }))
    }

    func finish() {
        coordinator.stop()
        sleeper.releaseAll()
        scratch.remove()
        try? FileManager.default.removeItem(at: vault)
    }

    func changeIndex(_ hash: String) throws {
        try rewriteManifest(IndexFiles.corpusDirs(vault: vault).papers) { $0["content_hash"] = hash }
    }
}

@Suite("IndexCoordinator")
@MainActor
struct IndexCoordinatorTests {
    @Test func aReloadConfiguresSearchAndReRunsTheQuery() async throws {
        let h = try Harness("reload", status: keywordOnlyStatus)
        defer { h.finish() }
        await h.coordinator.reloadIndexes()
        #expect(h.events.all == [.loaded(keywordOnlyStatus)])
        #expect(h.coordinator.status == keywordOnlyStatus)
        #expect(h.coordinator.embedding == .off("the index has no vectors"))
        // The query on screen was ranked again, with the new configuration already in place.
        await h.updates.wait { $0.last?.query == "stiff gels " }
        #expect(h.ranker.keywordCalls == ["stiff gels "])
        #expect(h.updates.all.last?.semantic == .off("the index has no vectors"))
    }

    @Test func aSemanticIndexGetsAnOllamaEmbedderFromItsModel() async throws {
        let h = try Harness("ollama")
        defer { h.finish() }
        await h.coordinator.reloadIndexes()
        #expect(h.coordinator.embedding == .ollama(baseURL: URL(string: "http://127.0.0.1:11434")!, model: "qwen3-embedding:0.6b",
                                                   dims: 8, instruction: "Instruct", keepAlive: "5m"))
        await h.updates.wait { $0.last?.query == "stiff gels " }
        #expect(h.updates.all.last?.semantic == .pending)
    }

    @Test func anUnchangedIndexDoesNothing() async throws {
        let h = try Harness("unchanged")
        defer { h.finish() }
        await h.coordinator.reloadIndexes()
        await h.updates.wait { !$0.isEmpty }
        await h.coordinator.reloadIndexes()
        #expect(h.events.all.count == 1 && h.ranker.loads == 1 && h.ranker.keywordCalls.count == 1)
        #expect(h.sleeper.requested == [IndexCoordinator.settleDelay], "no second settle GC")
    }

    @Test func theSettleGCRunsOnceAfterABurstOfReloads() async throws {
        let h = try Harness("settle")
        defer { h.finish() }
        await h.coordinator.reloadIndexes()
        await h.sleeper.waitForPending(1)
        #expect(h.ranker.garbageCollections == 0, "not before the delay")
        try h.changeIndex("second")
        await h.coordinator.reloadIndexes()            // replaces the first settle
        #expect(h.ranker.loads == 2)
        await h.sleeper.waitForPending(1)
        #expect(h.sleeper.requested == [3, 3])
        h.sleeper.releaseAll()
        await h.coordinator.settleTask?.value
        #expect(h.ranker.garbageCollections == 1)
    }

    @Test func aFailedReloadReportsItAndKeepsTheLoadedState() async throws {
        let h = try Harness("failed")
        defer { h.finish() }
        await h.coordinator.reloadIndexes()
        await h.updates.wait { !$0.isEmpty }
        let papers = IndexFiles.corpusDirs(vault: h.vault).papers
        try FileManager.default.removeItem(at: papers.appendingPathComponent("chunks.json"))
        try h.changeIndex("broken")
        await h.coordinator.reloadIndexes()
        guard case .failed(let message)? = h.events.all.last else { Issue.record("expected a failure, got \(h.events.all)"); return }
        #expect(message.contains("chunks.json"))
        #expect(h.coordinator.status == semanticStatus)
        #expect(h.ranker.keywordCalls.count == 1, "no re-query for a failed load")
    }

    @Test func settingsChangesReconfigureFromTheLoadedIndex() async throws {
        let h = try Harness("settings")
        defer { h.finish() }
        await h.coordinator.reconfigureEmbedding()
        #expect(h.coordinator.embedding == nil, "nothing loaded yet")
        await h.coordinator.reloadIndexes()
        let settings = SettingsStore(defaults: h.scratch.defaults)
        settings.ollamaURL = "http://127.0.0.1:9"
        settings.ollamaKeepAlive = "30m"
        await h.coordinator.reconfigureEmbedding()
        #expect(h.coordinator.embedding == .ollama(baseURL: URL(string: "http://127.0.0.1:9")!, model: "qwen3-embedding:0.6b",
                                                   dims: 8, instruction: "Instruct", keepAlive: "30m"))
    }

    @Test func anotherVaultStartsFromNothingAndLoadsIt() async throws {
        let h = try Harness("vault")
        defer { h.finish() }
        await h.coordinator.reloadIndexes()
        let other = try makeTempVault(notes: false)
        defer { try? FileManager.default.removeItem(at: other) }
        h.coordinator.openVault(other)
        #expect(h.coordinator.status == nil && h.coordinator.vault == other)
        await h.coordinator.loadTask?.value
        #expect(h.ranker.loads == 2 && h.coordinator.status == semanticStatus)
    }

    @Test func theWatchdogSwapsInAFreshEngineOnlyWhenHiddenOverTheLimitAndNotTooOften() async throws {
        let h = try Harness("watchdog")
        defer { h.finish() }
        await h.coordinator.reloadIndexes()
        h.footprint = 800
        h.panelVisible = true
        await h.coordinator.compactIfNeeded()
        #expect(h.ranker.loads == 1, "never while the panel is open")
        h.panelVisible = false
        await h.coordinator.compactIfNeeded()
        #expect(h.ranker.loads == 2)
        h.now += 60
        await h.coordinator.compactIfNeeded()
        #expect(h.ranker.loads == 2, "not again within the interval")
        #expect(h.logged.contains(prefix: "watchdog reload at 800 MB"))
    }

    @Test func theSafetyPollReloadsAChangeTheWatcherMissed() async throws {
        let h = try Harness("poll")
        defer { h.finish() }
        h.coordinator.start()
        await expectEventually(h.events.signal, "the first load") { h.events.all.count == 1 }
        await h.sleeper.waitForPending(2)              // the settle GC and the poll
        #expect(Set(h.sleeper.requested) == [IndexCoordinator.settleDelay, IndexCoordinator.pollInterval])
        try h.changeIndex("missed")
        h.sleeper.releaseAll()
        await expectEventually(h.events.signal, "the polled reload") { h.events.all.count == 2 }
        #expect(h.ranker.loads == 2)
    }
}
