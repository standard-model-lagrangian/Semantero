// Spike S1: measures the ranker options on a real or synthetic vault (docs/LAUNCHER_SPEC.md, "Ranker decision").
//   swift run -c release daito-bench --vault <dir> [--ranker <ranker.js>] [--label <text>] [--loads N] [--option a|b|both]
// With `--loads 1 --option a` (or b) one engine is loaded and measured: the clean memory figure (M4), because the
// default run loads a dozen throw-away contexts that JavaScriptCore collects lazily.
// M1 load, M2 keyword (incl. the JSON bridge), M3 hybrid for options A and B, M4 memory, M5 JSON bridge, M7 sgemv.
import DaitoSearchKit
import Foundation

JSCRanker.configureProcess()   // the app's own JavaScriptCore settings (spike S1)

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}
let vault = URL(fileURLWithPath: arg("--vault") ?? "\(NSHomeDirectory())/Documents/Obsidian Vault")
let rankerURL = URL(fileURLWithPath: arg("--ranker") ?? "../launcher-core/dist/ranker.js")
let label = arg("--label") ?? "default"
let loads = Int(arg("--loads") ?? "10") ?? 10
let option = arg("--option") ?? "both"

struct Stat { var p50: Double; var p95: Double; var max: Double; var n: Int }
func stat(_ ms: [Double]) -> Stat {
    let s = ms.sorted()
    func p(_ q: Double) -> Double { s.isEmpty ? 0 : s[min(s.count - 1, Int(q / 100 * Double(s.count)))] }
    return Stat(p50: p(50), p95: p(95), max: s.last ?? 0, n: s.count)
}
func ms(_ d: Duration) -> Double { Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15 }
func footprintMB() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    _ = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return Double(info.phys_footprint) / 1_048_576
}
func line(_ name: String, _ s: Stat) { print(String(format: "  %-34@ p50 %8.2f  p95 %8.2f  max %8.2f ms  (n=%d)", name as NSString, s.p50, s.p95, s.max, s.n)) }

let clock = ContinuousClock()
let dirs = IndexFiles.corpusDirs(vault: vault)
guard let papers = try IndexFiles.read(dir: dirs.papers) else { print("no papers index at \(dirs.papers.path)"); exit(1) }
let notes = try IndexFiles.read(dir: dirs.notes)
print("daito-bench [\(label)]  vault: \(vault.path)")
print("  papers vectors \((papers.vectors?.count ?? 0) / 1_048_576) MB, notes vectors \((notes?.vectors?.count ?? 0) / 1_048_576) MB")

if CommandLine.arguments.contains("--notesprobe") { try await notesProbe(papers: papers, notes: notes, rankerURL: rankerURL); exit(0) }
if let b = arg("--dropprobe") { try await dropProbe(papers: papers, notes: notes, bundle: URL(fileURLWithPath: b)); exit(0) }
if CommandLine.arguments.contains("--parseprobe") { parseProbe(papers: papers); exit(0) }
if CommandLine.arguments.contains("--heapprobe") { try await heapProbe(papers: papers, notes: notes, rankerURL: rankerURL); exit(0) }
if let probe = arg("--jsprobe2") { try jsProbe2(probeURL: URL(fileURLWithPath: probe), papers: papers); exit(0) }
if CommandLine.arguments.contains("--jsprobe") { await jsProbe(); exit(0) }
if CommandLine.arguments.contains("--memprobe") { try await memProbe(papers: papers, notes: notes, rankerURL: rankerURL); exit(0) }
let before = footprintMB()

// M1: background load (every load builds a fresh JSContext; the last one is kept for the queries below)
var loadMs: [Double] = []
var status = RankerStatus()
var ranker = try JSCRanker(rankerURL: rankerURL)
for i in 0..<max(1, loads) {
    if i > 0 { ranker = try JSCRanker(rankerURL: rankerURL) }
    let t = clock.now
    status = try await ranker.load(papers: papers, notes: notes)
    loadMs.append(ms(clock.now - t))
}
let accelerated = AcceleratedRanker(inner: ranker)
if option != "a" { _ = try await accelerated.load(papers: papers, notes: notes) }
let dims = status.dims ?? 1024
print("  papers \(status.papers?.count ?? 0), notes \(status.notes?.count ?? 0), dims \(dims), semantic \(status.anySemantic)")
print("M1 load (files → engine ready; incl. new JSContext)")
line("load", stat(loadMs))
if let t = status.timings { print(String(format: "   of which in JS: decode UTF-8 %.0f ms, JSON.parse %.0f ms, build indexes %.0f ms", t["decode"] ?? 0, t["parse"] ?? 0, t["build"] ?? 0)) }
print(String(format: "M4 resident footprint after load: %.0f MB (+%.0f MB vs before)", footprintMB(), footprintMB() - before))
if option != "both" || loads == 1 {
    for wait in [2.0, 3.0, 5.0] {
        try await Task.sleep(nanoseconds: UInt64(wait * 1e9))
        print(String(format: "   footprint %.0f s later: %.0f MB", wait, footprintMB()))
    }
}

// M2: keyword over every prefix of a set of queries, with the JSON bridge into Swift view models
let words = ["viscoelasticity", "stress relaxation", "stiffness hydrogel", "organoid", "chemoresistance integrin", "neural maturation",
             "constitutive model", "matrix degradation", "matrigel batch", "mitochondria transfer", "hydrogel", "weinberg", "meeting notes"]
var kw: [Double] = []
for _ in 0..<8 {
    for w in words { for n in stride(from: 3, through: w.count, by: 2) {
        let q = String(w.prefix(n))
        let t = clock.now
        _ = try await ranker.keyword(q, scope: .all, limit: 15)
        kw.append(ms(clock.now - t))
    } }
}
print("M2 keyword per keystroke (incl. JSON → [ResultVM])")
line("keyword, scope all", stat(kw))

// M5: the JSON bridge alone
let sample = try await ranker.keyword("organoid", scope: .all, limit: 15)
let json = try JSONEncoder().encode(sample)
var bridge: [Double] = []
for _ in 0..<500 {
    let t = clock.now
    _ = try JSONDecoder().decode([ResultVM].self, from: json)
    bridge.append(ms(clock.now - t))
}
print("M5 JSON bridge alone (decode \(sample.count) view models, \(json.count) bytes)")
line("decode", stat(bridge))

// M3 / M7: hybrid, option A (all JavaScriptCore) and option B (Accelerate vector pass)
func randomUnit(_ d: Int) -> [Float] {
    var v = (0..<d).map { _ in Float.random(in: -1...1) }
    let n = v.reduce(0) { $0 + $1 * $1 }.squareRoot()
    v = v.map { $0 / n }
    return v
}
let vecs = (0..<30).map { _ in randomUnit(dims) }
if option != "b" { _ = try await ranker.hybrid("viscoelasticity", queryVector: vecs[0], scope: .all, limit: 15) }
if option != "a" { _ = try await accelerated.hybrid("viscoelasticity", queryVector: vecs[0], scope: .all, limit: 15) }
var a: [Double] = [], b: [Double] = [], sg: [Double] = []
for i in 0..<200 {
    let q = words[i % words.count], v = vecs[i % vecs.count]
    var t = clock.now
    if option != "b" { _ = try await ranker.hybrid(q, queryVector: v, scope: .all, limit: 15); a.append(ms(clock.now - t)) }
    t = clock.now
    if option != "a" { _ = try await accelerated.hybrid(q, queryVector: v, scope: .all, limit: 15); b.append(ms(clock.now - t)) }
    t = clock.now
    if let pv = papers.vectors { _ = VectorScorer.rowScores(vectors: pv, dims: dims, query: v) }
    if let nv = notes?.vectors { _ = VectorScorer.rowScores(vectors: nv, dims: dims, query: v) }
    sg.append(ms(clock.now - t))
}
print("M3 hybrid scoring + merge, excluding Ollama")
line("A: all JavaScriptCore", stat(a))
line("B: JSC + Accelerate vector pass", stat(b))
print("M7 vector pass alone")
line("Accelerate (vDSP_mmul), both corpora", stat(sg))
print(String(format: "M4 final footprint: %.0f MB", footprintMB()))

if CommandLine.arguments.contains("--json") {
    let out: [String: Any] = [
        "label": label, "M1_p50": stat(loadMs).p50, "M1_max": stat(loadMs).max, "M2_p95": stat(kw).p95, "M3A_p95": stat(a).p95,
        "M3B_p95": stat(b).p95, "M4_mb": footprintMB(), "M5_p95": stat(bridge).p95, "M7_p95": stat(sg).p95,
    ]
    print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
}
