import DaitoSearchKit
import Foundation
import JavaScriptCore

/// `daito-bench --parseprobe`: does JSON.parse keep its source string alive, and what do chunk texts cost?
func parseProbe(papers: CorpusFiles) {
    let ctx = JSContext(virtualMachine: JSVirtualMachine())!
    func heap(_ label: String) {
        autoreleasepool {
            JSCPrivate.collectNow(ctx)
            let s = JSCPrivate.heapStatistics(ctx)
            print(String(format: "parseprobe: %-46@ heap %6.1f MB  strings %@", label as NSString, (s["heapSize"] ?? 0) / 1e6,
                         JSCPrivate.objectTypeCounts(ctx, top: 40).first { $0.0 == "string" }.map { String($0.1) } ?? "?"))
        }
    }
    heap("empty")
    autoreleasepool { ctx.setObject(String(decoding: papers.chunks, as: UTF8.self), forKeyedSubscript: "src" as NSString) }
    heap("chunks.json source string held")
    _ = autoreleasepool { ctx.evaluateScript("var chunks = JSON.parse(src); 0") }
    heap("parsed + source held")
    _ = autoreleasepool { ctx.evaluateScript("src = null; 0") }
    heap("parsed, source dropped")
    _ = autoreleasepool { ctx.evaluateScript("for (const c of chunks) { c.attachmentKey = null; c.heading = null } 0") }
    heap("… minus attachmentKey/heading strings")
    _ = autoreleasepool { ctx.evaluateScript("for (const c of chunks) c.text = null; 0") }
    heap("… minus chunk texts")
    _ = autoreleasepool { ctx.evaluateScript("chunks = null; 0") }
    heap("nothing")
}
