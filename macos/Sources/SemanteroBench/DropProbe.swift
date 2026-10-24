import SemanteroKit
import Foundation

/// `semantero-bench --dropprobe <debug bundle>`: heap after dropping parts of a loaded engine (debug bundle exposes __engine).
func dropProbe(papers: CorpusFiles, notes: CorpusFiles?, bundle: URL) async throws {
    let r = try JSCRanker(rankerURL: bundle)
    _ = try await r.load(papers: papers, notes: notes)
    func line(_ label: String) async {
        let s = await r.heapStatistics(collectFirst: true)
        print(String(format: "dropprobe: %-44@ heap %5.1f MB  extra %5.1f MB  objects %7.0f", label as NSString, (s["heapSize"] ?? 0) / 1e6, (s["extraMemorySize"] ?? 0) / 1e6, s["objectCount"] ?? 0))
    }
    await line("full engine")
    let steps: [(String, String)] = [
        ("drop notes corpus", "__engine.corpora.notes = null"),
        ("drop papers' vectors", "__engine.corpora.papers.ix.vectors = null"),
        ("drop BM25 index", "__engine.corpora.papers.ix.bm25 = null"),
        ("drop chunk objects", "__engine.corpora.papers.ix.chunks = null"),
        ("drop row tables", "const x = __engine.corpora.papers.ix; x.rowToChunk = x.rowToPaper = x.rowIsAbstract = x.paperChunkRows = x.paperAbstractRow = null"),
        ("drop papers metadata", "__engine.corpora.papers.ix.papers = null; __engine.corpora.papers.ix.manifest = null"),
        ("drop maps in corpora", "__engine.corpora.litnoteByCitekey = null; __engine.corpora.paperKeyByCitekey = null"),
        ("drop everything", "__engine = null; semantero = null"),
    ]
    for (label, js) in steps {
        _ = await r.evaluateForDiagnostics(js + "; 0")
        await line(label)
    }
}
