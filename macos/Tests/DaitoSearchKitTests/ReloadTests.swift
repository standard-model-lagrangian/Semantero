import Foundation
import Testing
@testable import DaitoSearchKit

@Suite("Reloading without blocking searches")
struct ReloadTests {
    @Test func searchesKeepAnsweringFromTheOldEngineWhileANewOneBuilds() async throws {
        let ranker = try await loadedJSCRanker()
        let big = syntheticCorpus(papers: 300, chunksPerPaper: 20)
        let clock = ContinuousClock()
        let start = clock.now
        async let loading = ranker.load(papers: big, notes: nil)
        try await Task.sleep(nanoseconds: 20_000_000)
        let t = clock.now
        let during = try await ranker.keyword("matrigel", scope: .all, limit: 5)
        let keywordTook = clock.now - t
        let status = try await loading
        let loadTook = clock.now - start
        #expect(during.first?.title == "Organoid bottlenecks", "old engine answered during the build")
        #expect(keywordTook < .milliseconds(100), "keyword waited \(keywordTook) during a \(loadTook) build")
        #expect(loadTook > keywordTook * 3, "the build should be much slower than one search for this test to mean anything")
        #expect(status.papers?.count == 300)
        #expect(try await ranker.keyword("hydrogel", scope: .papers, limit: 1).first?.title.hasPrefix("Paper") == true)
    }

    @Test func theLoadStartedLastWinsEvenIfItFinishesFirst() async throws {
        let ranker = try makeJSCRanker()
        let slow = syntheticCorpus(papers: 300, chunksPerPaper: 20, tag: "slow")
        let fast = syntheticCorpus(papers: 3, chunksPerPaper: 1, tag: "fast")
        async let first: RankerStatus? = try? ranker.load(papers: slow, notes: nil)
        try await Task.sleep(nanoseconds: 20_000_000)
        let second = try await ranker.load(papers: fast, notes: nil)
        let firstResult = await first
        #expect(second.papers?.count == 3)
        #expect(firstResult == nil, "the older load must report it was superseded")
        #expect(try await ranker.status().papers?.count == 3)
    }

    @Test func concurrentChecksLoadAChangeOnlyOnce() async throws {
        let vault = try makeTempVault()
        defer { try? FileManager.default.removeItem(at: vault) }
        let reloader = IndexReloader(vault: vault, ranker: try makeJSCRanker())
        let outcomes = await withTaskGroup(of: ReloadOutcome.self) { g in
            for _ in 0..<6 { g.addTask { await reloader.check() } }
            return await g.reduce(into: []) { $0.append($1) }
        }
        #expect(await reloader.reloadCount == 1)
        #expect(outcomes.filter { if case .reloaded = $0 { return true }; return false }.count == 1)
        #expect(outcomes.filter { $0 == .unchanged }.count == 5)
    }

    @Test func unreadableIndexGivesAnActionableMessage() async throws {
        let vault = try makeTempVault()
        let notes = IndexFiles.corpusDirs(vault: vault).notes
        defer { chmod(notes.path, 0o755); try? FileManager.default.removeItem(at: vault) }
        let reloader = IndexReloader(vault: vault, ranker: try makeJSCRanker())
        chmod(notes.appendingPathComponent("papers.json").path, 0o000)
        defer { chmod(notes.appendingPathComponent("papers.json").path, 0o644) }
        guard case .failed(let message) = await reloader.check() else { Issue.record("expected failure"); return }
        #expect(message.contains("Privacy & Security"), "\(message)")
    }
}

@Suite("Memory watchdog")
struct MemoryWatchdogTests {
    @Test func compactsOnlyWhenOverThresholdHiddenAndNotTooOften() {
        var w = MemoryWatchdog(thresholdMB: 350, minInterval: 600)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        #expect(!w.shouldCompact(footprintMB: 300, panelVisible: false, now: t0))   // under the threshold
        #expect(!w.shouldCompact(footprintMB: 800, panelVisible: true, now: t0))    // never while you're searching
        #expect(w.shouldCompact(footprintMB: 800, panelVisible: false, now: t0))
        w.didCompact(at: t0)
        #expect(!w.shouldCompact(footprintMB: 800, panelVisible: false, now: t0.addingTimeInterval(599)))
        #expect(w.shouldCompact(footprintMB: 800, panelVisible: false, now: t0.addingTimeInterval(601)))
    }

    @Test func footprintIsReadable() { #expect(MemoryWatchdog.footprintMB() > 0) }
}
