import Foundation
import Testing
@testable import DaitoSearchKit

private final class FakeIndex: SpotlightIndexing, @unchecked Sendable {
    private let lock = NSLock()
    private var _indexed: [SearchableItem] = []
    private var _deletedIDs: [String] = []
    private var _deletedDomains: [String] = []
    private var _calls = 0
    var indexed: [SearchableItem] { lock.withLock { _indexed } }
    var deletedIDs: [String] { lock.withLock { _deletedIDs } }
    var deletedDomains: [String] { lock.withLock { _deletedDomains } }
    var calls: Int { lock.withLock { _calls } }
    func index(_ items: [SearchableItem]) async throws { lock.withLock { _indexed += items; _calls += 1 } }
    func delete(ids: [String]) async throws { lock.withLock { _deletedIDs += ids; _calls += 1 } }
    func deleteDomain(_ domain: String) async throws { lock.withLock { _deletedDomains.append(domain); _calls += 1 } }
}

private func donor(_ index: FakeIndex) -> SpotlightDonor {
    let state = FileManager.default.temporaryDirectory.appendingPathComponent("daito-spot-\(UUID().uuidString)/spotlight.json")
    return SpotlightDonor(index: index, stateURL: state)
}

private func data(_ dir: URL, _ name: String) throws -> Data { try Data(contentsOf: dir.appendingPathComponent(name)) }

private func sync(_ d: SpotlightDonor, papers: Data? = nil, notes: Data? = nil, chunks: Data? = nil,
                  settings: SpotlightSettings = SpotlightSettings()) async throws -> SyncReport {
    try await d.sync(papers: papers ?? data(Repo.papersDir, "papers.json"), notes: notes ?? data(Repo.notesDir, "papers.json"),
                     chunks: chunks, settings: settings, zoteroStorage: "/Z/storage", vault: "/V")
}

@Suite("SpotlightDonor")
struct SpotlightTests {
    // S33
    @Test func firstSyncDonatesPapersAndNoteTitlesNoAbstractsNoNoteText() async throws {
        let index = FakeIndex()
        let report = try await sync(donor(index))
        #expect(report == SyncReport(indexed: 11, deleted: 0))
        let items = index.indexed
        #expect(items.filter { $0.domain == "papers" }.count == 4)
        #expect(items.filter { $0.domain == "notes" }.count == 7)
        let roth = try #require(items.first { $0.id == "P:KEY0001" })
        #expect(roth.title.hasPrefix("Tunable hydrogel"))
        #expect(roth.description == "Roth & Bauer · 2023 · Science Advances")
        #expect(roth.keywords.contains("roth2023tunable"))
        #expect(roth.contentURL?.path == "/Z/storage/ATT001/sample.pdf")
        let abstract = "Faster stress relaxation accelerated neuronal maturation"
        for item in items {
            #expect(!item.description.contains(abstract) && item.textContent == nil, "\(item.id) leaks body text")
        }
        let note = try #require(items.first { $0.title == "Organoid bottlenecks" })
        #expect(note.keywords.contains("organoids") && note.keywords.contains("org bottlenecks"))   // tags and aliases
        #expect(note.contentURL?.path == "/V/Organoid bottlenecks.md")
    }

    // S34
    @Test func secondSyncWithNoChangeMakesZeroCalls() async throws {
        let index = FakeIndex(), d = donor(index)
        _ = try await sync(d)
        let before = index.calls
        #expect(try await sync(d) == SyncReport(indexed: 0, deleted: 0))
        #expect(index.calls == before)
    }

    // S35
    @Test func changedPaperIsRedonatedOnceAndRemovedNoteIsDeletedOnce() async throws {
        let index = FakeIndex(), d = donor(index)
        _ = try await sync(d)
        var papers = try #require(JSONSerialization.jsonObject(with: data(Repo.papersDir, "papers.json")) as? [[String: Any]])
        papers[0]["title"] = "A new title"
        var notes = try #require(JSONSerialization.jsonObject(with: data(Repo.notesDir, "papers.json")) as? [[String: Any]])
        let removed = try #require(notes.removeLast()["key"] as? String)
        let report = try await sync(d, papers: JSONSerialization.data(withJSONObject: papers), notes: JSONSerialization.data(withJSONObject: notes))
        #expect(report == SyncReport(indexed: 1, deleted: 1))
        #expect(index.indexed.last?.title == "A new title")
        #expect(index.deletedIDs == ["N:\(removed)"])
    }

    // S36
    @Test func excludedNotesAreNeverDonated() async throws {
        let index = FakeIndex()
        _ = try await sync(donor(index))
        let titles = index.indexed.map(\.title)
        for forbidden in ["bank", "Daily", "Threads", "workspace"] { #expect(!titles.contains { $0.contains(forbidden) }) }
        #expect(!index.indexed.contains { $0.contentURL?.path.contains("/Private/") == true })
    }

    // S37
    @Test func noteTextSettingDonatesTextAndTurningADomainOffDeletesIt() async throws {
        let index = FakeIndex(), d = donor(index)
        _ = try await sync(d)
        let chunks = try data(Repo.notesDir, "chunks.json")
        let on = try await sync(d, chunks: chunks, settings: SpotlightSettings(papers: true, noteTitles: true, noteText: true))
        #expect(on.indexed >= 1)
        let withText = index.indexed.filter { $0.domain == "notes" && $0.textContent != nil }
        #expect(withText.contains { $0.textContent!.contains("batch to batch") })

        let off = try await sync(d, chunks: chunks, settings: SpotlightSettings(papers: true, noteTitles: false, noteText: false))
        #expect(index.deletedDomains == ["notes"])
        #expect(off.deleted == 7)
        let again = try await sync(d, chunks: chunks, settings: SpotlightSettings(papers: true, noteTitles: false, noteText: false))
        #expect(again == SyncReport(indexed: 0, deleted: 0))
        let papersOff = try await sync(d, settings: SpotlightSettings(papers: false, noteTitles: false, noteText: false))
        #expect(papersOff.deleted == 4 && index.deletedDomains == ["notes", "papers"])
    }

    // S38
    @Test func aSpotlightIdentifierResolvesToTheResultAndRunsOpen() async throws {
        let ranker = FakeRanker()
        ranker.lookupResults["P:KEY0001"] = vm("P:KEY0001", openUrl: "zotero://open-pdf/library/items/ATT001?page=1")
        let opened = CallLog()
        struct WS: WorkspaceService { let log: CallLog; func open(_ url: URL) { log.add("open:\(url.absoluteString)") }; func reveal(_ url: URL) {} }
        struct Nop: PasteboardService, KeyEventPosting, SystemState, FileChecking, PanelControl, Toasting, QuickLooking {
            func snapshot() -> PasteboardSnapshot { PasteboardSnapshot(items: []) }
            func restore(_ s: PasteboardSnapshot) {}
            func writeFile(_ url: URL) {}
            func writeString(_ t: String) {}
            func postCommandV() {}
            var accessibilityTrusted: Bool { true }
            var secureInputEnabled: Bool { false }
            func exists(_ path: String) -> Bool { true }
            func hide() async {}
            func show(_ message: String, action: ToastAction?) {}
            func preview(_ url: URL) {}
        }
        let n = Nop()
        let executor = ActionExecutor(services: ActionServices(pasteboard: n, events: n, workspace: WS(log: opened), system: n, files: n,
                                                              panel: n, toast: n, quickLook: n))
        let service = SpotlightOpenService(ranker: ranker, executor: executor)
        #expect(await service.open(identifier: "P:KEY0001") == .done)
        #expect(opened.all == ["open:zotero://open-pdf/library/items/ATT001?page=1"])
        #expect(await service.open(identifier: "P:GONE") == .failed("Result not found: P:GONE"))
    }
}
