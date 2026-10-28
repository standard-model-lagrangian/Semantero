import SemanteroKit
import Foundation

/// `semantero-bench --memprobe`: footprint after each stage of loading, to find what holds the memory.
func memProbe(papers: CorpusFiles, notes: CorpusFiles?, rankerURL: URL) async throws {
    func mb() -> String { String(format: "%.0f MB", footprintMB()) }
    func settle() async -> String { let a = mb(); try? await Task.sleep(nanoseconds: 4_000_000_000); return "\(a) → \(mb()) after 4 s" }
    print("memprobe: start \(mb())")
    let r = try JSCRanker(rankerURL: rankerURL)
    _ = try await r.load(papers: nil, notes: nil)
    print("memprobe: empty engine (context + bundle) \(await settle())")
    _ = try await r.load(papers: papers, notes: nil)
    print("memprobe: papers only \(await settle())")
    _ = try await r.load(papers: papers, notes: notes)
    print("memprobe: papers + notes (replaces the context above) \(await settle())")
    _ = try await r.load(papers: papers, notes: notes)
    print("memprobe: reloaded again \(await settle())")
    for _ in 0..<50 { _ = try await r.keyword("viscoelasticity stress", scope: .all, limit: 15) }
    print("memprobe: after 50 keyword queries \(await settle())")
    let v = (0..<1024).map { _ in Float.random(in: -1...1) }
    for _ in 0..<50 { _ = try await r.hybrid("viscoelasticity stress", queryVector: v, scope: .all, limit: 15) }
    print("memprobe: after 50 hybrid queries \(await settle())")
}
