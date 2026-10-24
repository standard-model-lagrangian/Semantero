import SemanteroKit
import Foundation

/// `semantero-bench --heapprobe`: JavaScriptCore heap (live) vs process footprint after one load, a synchronous GC,
/// searches, and idling. `--no-gc-timer` disables the idle GC timers first.
func heapProbe(papers: CorpusFiles, notes: CorpusFiles?, rankerURL: URL) async throws {
    if CommandLine.arguments.contains("--no-gc-timer") { JSCPrivate.disableGCTimer() }
    let r = try JSCRanker(rankerURL: rankerURL)
    func line(_ label: String, gc: Bool = false) async {
        let s = await r.heapStatistics(collectFirst: gc)
        print(String(format: "heapprobe: %-34@ heap %5.0f MB  capacity %5.0f MB  extra %5.0f MB  objects %8.0f  | footprint %5d MB",
                     label as NSString, (s["heapSize"] ?? 0) / 1e6, (s["heapCapacity"] ?? 0) / 1e6, (s["extraMemorySize"] ?? 0) / 1e6,
                     s["objectCount"] ?? 0, MemoryWatchdog.footprintMB()))
    }
    _ = try await r.load(papers: papers, notes: notes)
    await line("after load")
    await line("after synchronous full GC", gc: true)
    print("heapprobe: object types:", await r.objectTypeCounts().map { "\($0.0)=\($0.1)" }.joined(separator: " "))
    if CommandLine.arguments.contains("--types-only") { return }
    for q in ["organoid", "stress relaxation hydrogel", "viscoelastic", "matrigel batch", "neural"] {
        _ = try await r.keyword(q, scope: .all, limit: 15)
        _ = try await r.hybrid(q, queryVector: (0..<1024).map { _ in Float.random(in: -1...1) }, scope: .all, limit: 15)
    }
    await line("after 10 searches")
    for t in [30, 60, 120, 180, 240] {
        try await Task.sleep(nanoseconds: UInt64(t == 30 ? 30 : (t == 60 ? 30 : 60)) * 1_000_000_000)
        await line("idle \(t) s")
    }
    await line("idle, then synchronous GC", gc: true)
}
