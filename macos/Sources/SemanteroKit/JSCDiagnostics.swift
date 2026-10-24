import Foundation
import JavaScriptCore

/// JavaScriptCore entry points that are exported but not in the public headers (JSBasePrivate.h). Looked up at run time;
/// every caller copes with them being absent.
public enum JSCPrivate {
    nonisolated(unsafe) private static let handle = dlopen("/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore", RTLD_NOW)
    private typealias StatsFn = @convention(c) (JSContextRef) -> JSObjectRef?
    private typealias CtxFn = @convention(c) (JSContextRef) -> Void
    private typealias VoidFn = @convention(c) () -> Void

    /// A full, synchronous collection (JSGarbageCollect only schedules one).
    public static func collectNow(_ ctx: JSContext) {
        guard let s = dlsym(handle, "JSSynchronousGarbageCollectForDebugging") else { JSGarbageCollect(ctx.jsGlobalContextRef); return }
        unsafeBitCast(s, to: CtxFn.self)(ctx.jsGlobalContextRef)
    }

    /// Stops JavaScriptCore's idle-time GC timers for the process.
    public static func disableGCTimer() {
        if let s = dlsym(handle, "JSDisableGCTimer") { unsafeBitCast(s, to: VoidFn.self)() }
    }

    /// Object counts by type, largest first (diagnostics).
    public static func objectTypeCounts(_ ctx: JSContext, top: Int = 15) -> [(String, Int)] {
        guard let s = dlsym(handle, "JSGetMemoryUsageStatistics"),
              let obj = unsafeBitCast(s, to: StatsFn.self)(ctx.jsGlobalContextRef),
              let counts = JSValue(jsValueRef: obj, in: ctx)?.objectForKeyedSubscript("objectTypeCounts"),
              let dict = counts.toDictionary() as? [String: NSNumber] else { return [] }
        return dict.map { ($0.key, $0.value.intValue) }.sorted { $0.1 > $1.1 }.prefix(top).map { $0 }
    }

    /// heapSize, heapCapacity, extraMemorySize, objectCount… (bytes / counts), or [:].
    public static func heapStatistics(_ ctx: JSContext) -> [String: Double] {
        guard let s = dlsym(handle, "JSGetMemoryUsageStatistics"),
              let obj = unsafeBitCast(s, to: StatsFn.self)(ctx.jsGlobalContextRef) else { return [:] }
        let value = JSValue(jsValueRef: obj, in: ctx)
        var out: [String: Double] = [:]
        for key in ["heapSize", "heapCapacity", "extraMemorySize", "objectCount"] {
            if let v = value?.objectForKeyedSubscript(key), v.isNumber { out[key] = v.toDouble() }
        }
        return out
    }
}
