import DaitoSearchKit
import Foundation

/// `daito-bench --memprobe`: footprint after each stage of loading, to find what holds the memory.
func memProbe(papers: CorpusFiles, notes: CorpusFiles?, rankerURL: URL) async throws {
    func mb() -> String {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        _ = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return String(format: "%.0f MB", Double(info.phys_footprint) / 1_048_576)
    }
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

import JavaScriptCore

/// `daito-bench --jsprobe`: does JavaScriptCore give memory back when a VM goes away?
func jsProbe() async {
    func mb() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        _ = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return Double(info.phys_footprint) / 1_048_576
    }
    print(String(format: "jsprobe: start %.0f MB", mb()))
    weak var weakCtx: JSContext?
    weak var weakVM: JSVirtualMachine?
    autoreleasepool {
        let vm = JSVirtualMachine()!
        let ctx = JSContext(virtualMachine: vm)!
        weakCtx = ctx; weakVM = vm
        ctx.evaluateScript("var keep = []; for (var i = 0; i < 1000000; i++) keep.push({a: i, b: i * 2, c: 'x' + (i % 1000)});")
        print(String(format: "jsprobe: 1M objects live %.0f MB", mb()))
        ctx.evaluateScript("var m = new Map(); for (var i = 0; i < 65000; i++) m.set('term' + i, {ids: new Int32Array(20), s: new Float64Array(20)});")
        print(String(format: "jsprobe: + 65k typed-array pairs in a Map %.0f MB", mb()))
        ctx.evaluateScript("keep = null; m = null;")
        JSGarbageCollect(ctx.jsGlobalContextRef)
        print(String(format: "jsprobe: after dropping + GC (context alive) %.0f MB", mb()))
    }
    print("jsprobe: context freed: \(weakCtx == nil), vm freed: \(weakVM == nil)")
    for t in [1.0, 3.0] {
        try? await Task.sleep(nanoseconds: UInt64(t * 1e9))
        print(String(format: "jsprobe: %.0f s after release: %.0f MB", t, mb()))
    }
}

/// `daito-bench --jsprobe2 <probe.js>`: footprint after each stage of the BM25 build (real code, real chunks).
func jsProbe2(probeURL: URL, papers: CorpusFiles) throws {
    func mb() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        _ = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return Double(info.phys_footprint) / 1_048_576
    }
    let ctx = JSContext(virtualMachine: JSVirtualMachine())!
    ctx.exceptionHandler = { _, v in print("JS error:", v?.toString() ?? "?") }
    ctx.evaluateScript(try String(contentsOf: probeURL, encoding: .utf8))
    let probe = ctx.objectForKeyedSubscript("probe")!
    func stage(_ name: String, _ f: () -> Void) {
        let t = ContinuousClock().now
        f()
        JSGarbageCollect(ctx.jsGlobalContextRef)
        let d = ContinuousClock().now - t
        print(String(format: "jsprobe2: %-34@ %7.0f MB  (%.0f ms)", name as NSString, mb(), Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15))
    }
    print(String(format: "jsprobe2: start %.0f MB", mb()))
    let p = String(decoding: papers.papers, as: UTF8.self), c = String(decoding: papers.chunks, as: UTF8.self)
    stage("JSON.parse papers+chunks") { _ = probe.invokeMethod("parse", withArguments: [p, c]) }
    stage("tokenize all (discard)") { _ = probe.invokeMethod("tokenizeAll", withArguments: []) }
    stage("per-chunk term Maps (kept)") { _ = probe.invokeMethod("mapsOnly", withArguments: []) }
    stage("drop Maps") { _ = probe.invokeMethod("dropTokens", withArguments: []) }
    stage("token arrays (kept)") { _ = probe.invokeMethod("keepTokens", withArguments: []) }
    stage("drop token arrays") { _ = probe.invokeMethod("dropTokens", withArguments: []) }
    stage("BM25Index build (kept)") { _ = probe.invokeMethod("build", withArguments: []) }
    stage("drop index") { _ = probe.invokeMethod("dropIndex", withArguments: []) }
    if ctx.evaluateScript("typeof $vm")?.toString() == "object" {
        stage("$vm.gc() (full, synchronous)") { _ = ctx.evaluateScript("$vm.gc()") }
        for t in [1.0, 3.0] {
            Thread.sleep(forTimeInterval: t)
            print(String(format: "jsprobe2: %.0f s later %.0f MB", t, mb()))
        }
    } else { print("jsprobe2: $vm not available (run with JSC_useDollarVM=1)") }
}

