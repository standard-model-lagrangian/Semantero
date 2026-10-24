import Foundation
import Testing
@testable import SemanteroKit

@Suite("Index files and reloading")
struct IndexTests {
    // S1
    @Test func readsBothFixtureCorporaAndMapsTheVectors() throws {
        let f = try fixtureFiles()
        #expect(f.papers.vectors?.count == 4 * 4 * 8 + 0 || (f.papers.vectors?.count ?? 0) > 0)
        #expect(!f.papers.contentHash.isEmpty && !f.notes.contentHash.isEmpty)
        // A big sparse vectors.f32 must be mapped, not copied into memory.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("semantero-big-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        for n in ["manifest.json", "papers.json", "chunks.json"] {
            try FileManager.default.copyItem(at: Repo.papersDir.appendingPathComponent(n), to: dir.appendingPathComponent(n))
        }
        let big = dir.appendingPathComponent("vectors.f32")
        FileManager.default.createFile(atPath: big.path, contents: nil)
        let h = try FileHandle(forWritingTo: big)
        let size: UInt64 = 256 * 1024 * 1024
        try h.truncate(atOffset: size)
        try h.close()
        let before = physFootprint()
        let read = try #require(try IndexFiles.read(dir: dir))
        let grew = physFootprint() &- before
        #expect(UInt64(read.vectors?.count ?? 0) == size)
        #expect(grew < size / 4, "reading grew the footprint by \(grew) bytes: the file was copied, not mapped")
    }

    @Test func missingManifestMeansNoCorpus() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("semantero-none-\(UUID().uuidString)")
        #expect(try IndexFiles.read(dir: dir) == nil)
        #expect(IndexFiles.manifestHash(of: dir) == nil)
    }

    // S2
    @Test func missingCorpusLoadsPartiallyWithAReason() async throws {
        let vault = try makeTempVault(notes: false)
        defer { try? FileManager.default.removeItem(at: vault) }
        let reloader = IndexReloader(vault: vault, ranker: try makeJSCRanker())
        guard case .reloaded(let status) = await reloader.check() else { Issue.record("expected a reload"); return }
        #expect(status.papers?.count == 4)
        #expect(status.notes == nil)
        #expect(status.flags.contains("notes index missing"))
    }

    // S3
    @Test func unchangedHashNeverReloadsChangedHashReloadsOnce() async throws {
        let vault = try makeTempVault()
        defer { try? FileManager.default.removeItem(at: vault) }
        let reloader = IndexReloader(vault: vault, ranker: try makeJSCRanker())
        _ = await reloader.check()
        #expect(await reloader.reloadCount == 1)
        for _ in 0..<3 { #expect(await reloader.check() == .unchanged) }
        #expect(await reloader.reloadCount == 1)
        try rewriteManifest(IndexFiles.corpusDirs(vault: vault).notes) { $0["content_hash"] = "changed" }
        guard case .reloaded = await reloader.check() else { Issue.record("expected a reload"); return }
        #expect(await reloader.reloadCount == 2)
        #expect(await reloader.check() == .unchanged)
    }

    @Test func forceReloadLoadsAgainEvenWhenNothingChanged() async throws {
        let vault = try makeTempVault()
        defer { try? FileManager.default.removeItem(at: vault) }
        let ranker = try makeJSCRanker()
        let reloader = IndexReloader(vault: vault, ranker: ranker)
        _ = await reloader.check()
        #expect(await reloader.check() == .unchanged)
        guard case .reloaded(let s) = await reloader.forceReload() else { Issue.record("expected a reload"); return }
        #expect(s.papers?.count == 4)
        #expect(await reloader.reloadCount == 2)
        #expect(!(try await ranker.keyword("matrigel", scope: .all, limit: 3)).isEmpty)
        #expect(await reloader.check() == .unchanged)
    }

    @Test func burstOfFileEventsBecomesOneCheckAfterTheDebounce() {
        let scheduler = ManualScheduler()
        let calls = CallLog()
        let watcher = IndexWatcher(directory: FileManager.default.temporaryDirectory, scheduler: scheduler, debounce: 0.5) {
            calls.add("check")
        }
        for _ in 0..<5 { watcher.poke(); scheduler.advance(by: 0.2) }   // each poke restarts the 0.5 s window
        #expect(calls.all.isEmpty)
        scheduler.advance(by: 0.5)
        #expect(calls.all == ["check"])
        scheduler.advance(by: 5)
        #expect(calls.all == ["check"])
    }

    @Test func realFSEventsWatcherSeesAFileChange() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("semantero-fse-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let calls = CallLog()
        let watcher = IndexWatcher(directory: dir, debounce: 0.2) { calls.add("check") }
        #expect(watcher.start())
        try await Task.sleep(nanoseconds: 300_000_000)
        try Data("x".utf8).write(to: dir.appendingPathComponent("manifest.json"))
        let deadline = Date().addingTimeInterval(5)
        while calls.all.isEmpty, Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        watcher.stop()
        #expect(!calls.all.isEmpty)
    }

    // S4
    @Test func halfWrittenIndexNeverLoadsAndTheOldEngineStays() async throws {
        let vault = try makeTempVault()
        defer { try? FileManager.default.removeItem(at: vault) }
        let ranker = try makeJSCRanker()
        let reloader = IndexReloader(vault: vault, ranker: ranker)
        _ = await reloader.check()
        let before = try await ranker.keyword("matrigel", scope: .all, limit: 3)
        #expect(!before.isEmpty)

        let planner = vault.appendingPathComponent(".planner")
        try FileManager.default.createDirectory(at: planner.appendingPathComponent("notes.tmp"), withIntermediateDirectories: true)
        try FileManager.default.removeItem(at: planner.appendingPathComponent("notes"))   // mid-swap: the folder is gone
        #expect(await reloader.check() == .deferred)
        #expect(try await ranker.keyword("matrigel", scope: .all, limit: 3) == before)
        #expect(await reloader.reloadCount == 1)

        // the swap finishes with a new build
        try FileManager.default.removeItem(at: planner.appendingPathComponent("notes.tmp"))
        try FileManager.default.copyItem(at: Repo.notesDir, to: planner.appendingPathComponent("notes"))
        try rewriteManifest(planner.appendingPathComponent("notes")) { $0["content_hash"] = "rebuilt" }
        guard case .reloaded = await reloader.check() else { Issue.record("expected a reload after the swap"); return }
    }

    @Test func loadFailureKeepsTheOldEngineAndIsReportedAsFailed() async throws {
        let vault = try makeTempVault()
        defer { try? FileManager.default.removeItem(at: vault) }
        let ranker = try makeJSCRanker()
        let reloader = IndexReloader(vault: vault, ranker: ranker)
        _ = await reloader.check()
        let notes = IndexFiles.corpusDirs(vault: vault).notes
        try Data("[broken".utf8).write(to: notes.appendingPathComponent("papers.json"))
        try rewriteManifest(notes) { $0["content_hash"] = "broken" }
        guard case .failed = await reloader.check() else { Issue.record("expected failure"); return }
        #expect(!(try await ranker.keyword("matrigel", scope: .all, limit: 3)).isEmpty)
    }
}
