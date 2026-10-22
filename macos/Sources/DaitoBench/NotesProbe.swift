import DaitoSearchKit
import Foundation

/// `daito-bench --notesprobe`: how long a notes-only reload (incl. its synchronous GC) holds the ranker's actor.
func notesProbe(papers: CorpusFiles, notes: CorpusFiles?, rankerURL: URL) async throws {
    let r = try JSCRanker(rankerURL: rankerURL)
    _ = try await r.load(papers: papers, notes: notes)
    var total: [Double] = [], gc: [Double] = []
    let clock = ContinuousClock()
    for _ in 0..<10 {
        let t = clock.now
        _ = try await r.reloadNotes(notes)
        let d = clock.now - t
        total.append(Double(d.components.attoseconds) / 1e15 + Double(d.components.seconds) * 1000)
        let g = await r.lastNotesGC
        gc.append(Double(g.components.attoseconds) / 1e15 + Double(g.components.seconds) * 1000)
    }
    print(String(format: "notesprobe: notes-only reload median %.1f ms (max %.1f), of which synchronous GC median %.1f ms; footprint %d MB",
                 total.sorted()[5], total.max()!, gc.sorted()[5], MemoryWatchdog.footprintMB()))
}
