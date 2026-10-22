import Foundation
import JavaScriptCore

/// Records JavaScript exceptions raised while a call is running.
private final class ExceptionBox: @unchecked Sendable {
    private(set) var error: RankerError?
    func record(_ value: JSValue?) {
        let message = value?.toString() ?? "unknown JavaScript error"
        let stack = value?.objectForKeyedSubscript("stack")
        let stackText = (stack?.isUndefined ?? true) ? nil : stack?.toString()
        error = RankerError(message, stack: stackText)
    }
    func take() -> RankerError? { defer { error = nil }; return error }
}

/// The TypeScript ranking core (launcher-core/dist/ranker.js) running in JavaScriptCore. Each load builds a new engine
/// (its own virtual machine and context) off the actor; once installed, an engine is only used from this actor.
public actor JSCRanker: NotesReloading {
    /// The bundle version this app build expects: launcher-core/package.json "version".
    public static let expectedVersion = "1.0.0"

    /// Spike S1 (docs/DECISIONS_AND_GAPS.md): with the default JIT tiers JavaScriptCore's compiler arenas pushed the
    /// process to 500-800 MB; without the DFG and FTL tiers (baseline JIT only) the steady state is 150-200 MB and
    /// load, keyword and hybrid times are unchanged. JavaScriptCore reads these when it first starts, so call this
    /// before any ranker is created. A value the user has set in the environment wins.
    public static func configureProcess() {
        for (name, value) in [("JSC_useFTLJIT", "0"), ("JSC_useDFGJIT", "0")] { setenv(name, value, 0) }
    }

    /// One loaded engine: a context on its own virtual machine. After it is installed only this actor uses it.
    private final class Engine: @unchecked Sendable {
        let ctx: JSContext
        let api: JSValue
        let exceptions: ExceptionBox
        init(ctx: JSContext, api: JSValue, exceptions: ExceptionBox) { self.ctx = ctx; self.api = api; self.exceptions = exceptions }
    }

    private let source: String
    private let expectedVersion: String
    private var engine: Engine?
    private var loadGeneration = 0
    private var installedGeneration = 0

    public init(rankerURL: URL, expectedVersion: String = JSCRanker.expectedVersion) throws {
        self.source = try String(contentsOf: rankerURL, encoding: .utf8)
        self.expectedVersion = expectedVersion
    }

    // MARK: Ranker

    public func load(papers: CorpusFiles?, notes: CorpusFiles?) async throws -> RankerStatus {
        // The new engine is built on its own virtual machine, off this actor, so searches keep using the current engine
        // while it builds (a build takes ~0.5 s at today's library size; before, every keystroke waited for it).
        loadGeneration += 1
        let generation = loadGeneration
        let source = self.source, expected = self.expectedVersion
        let built = try await Task.detached(priority: .userInitiated) {
            try Self.build(source: source, expectedVersion: expected, papers: papers, notes: notes)
        }.value
        // Two loads in flight: the one started last wins, whichever finishes first.
        guard generation > installedGeneration else {
            throw RankerError("superseded by a newer load")
        }
        installedGeneration = generation
        let old = engine
        engine = built.engine
        _ = old  // released here: its virtual machine is torn down with it
        return built.status
    }

    /// Swaps in a new notes corpus inside the current engine (on this actor: keep it to small notes indexes, see
    /// IndexReloader.partialReloadLimit). A failure keeps the current engine.
    public func reloadNotes(_ notes: CorpusFiles?) async throws -> RankerStatus {
        guard let engine else { throw RankerError("no index loaded") }
        return try autoreleasepool {
            _ = engine.exceptions.take()
            let part: Any = try notes.map { try Self.part($0, in: engine.ctx) } ?? NSNull()
            let result = engine.api.invokeMethod("loadNotes", withArguments: [part])
            if let e = engine.exceptions.take() { throw e }
            guard let result else { throw RankerError("loadNotes returned nothing") }
            let status = try Self.decode(RankerStatus.self, from: result)
            // The replaced notes corpus is garbage in this same engine: collect it now, or each reload keeps ~15 MB.
            let t = ContinuousClock.now
            JSCPrivate.collectNow(engine.ctx)
            lastNotesGC = ContinuousClock.now - t
            return status
        }
    }

    /// A synchronous full collection of the live engine (~1–2 ms). Run a few seconds after a full load: what the load left
    /// behind outside the new engine (the replaced engine, transfer buffers) can only be reclaimed once it is installed.
    public func collectGarbage() {
        guard let engine else { return }
        autoreleasepool { JSCPrivate.collectNow(engine.ctx) }
    }

    /// How long the synchronous collection after the last notes-only reload took (diagnostics).
    public private(set) var lastNotesGC: Duration = .zero

    /// Builds an engine on a fresh virtual machine. Touches no actor state, so it can run on any thread.
    /// Everything runs inside an autorelease pool: JSValues come back autoreleased, and on a Swift concurrency thread
    /// nothing else would drain them, so each one would pin its whole context (and the index inside it).
    private static func build(source: String, expectedVersion: String, papers: CorpusFiles?,
                              notes: CorpusFiles?) throws -> (engine: Engine, status: RankerStatus) {
        try autoreleasepool {
            let box = ExceptionBox()
            let ctx = JSContext(virtualMachine: JSVirtualMachine())!
            ctx.exceptionHandler = { _, value in box.record(value) }
            ctx.evaluateScript(source)
            if let e = box.take() { throw e }
            guard let api = ctx.objectForKeyedSubscript("daito"), !api.isUndefined else {
                throw RankerError("ranker.js did not define daito")
            }
            let version = api.objectForKeyedSubscript("version")?.toString() ?? ""
            guard version == expectedVersion else {
                throw RankerError("ranker.js version \(version) does not match this app (\(expectedVersion))")
            }
            let papersPart = try papers.map { try part($0, in: ctx) }
            let notesPart = try notes.map { try part($0, in: ctx) }
            let result = api.invokeMethod("load", withArguments: [papersPart ?? NSNull(), notesPart ?? NSNull()])
            if let e = box.take() { throw e }
            guard let result else { throw RankerError("load returned nothing") }
            let status = try decode(RankerStatus.self, from: result)
            // Building churns several times the engine's final size. A synchronous full collection here (off the query
            // actor) lets the allocator hand that back within seconds; JSGarbageCollect only schedules one, and without
            // it the process stayed at ~800 MB (measured; DECISIONS_AND_GAPS.md, "Memory pass").
            JSCPrivate.collectNow(ctx)
            return (Engine(ctx: ctx, api: api, exceptions: box), status)
        }
    }

    public func status() async throws -> RankerStatus {
        try callDecode(RankerStatus.self, "status", [])
    }

    public func shouldRunSemantic(_ query: String) async -> Bool {
        autoreleasepool { (try? call("shouldRunSemantic", [query]))?.toBool() ?? false }
    }

    public func keyword(_ query: String, scope: Scope, limit: Int) async throws -> [ResultVM] {
        try callDecode([ResultVM].self, "keyword", [query, scope.rawValue, limit])
    }

    public func hybrid(_ query: String, queryVector: [Float], scope: Scope, limit: Int) async throws -> [ResultVM] {
        try autoreleasepool {
            let v = try Self.copyBuffer(queryVector, in: requireContext())
            return try Self.decode([ResultVM].self, from: try call("hybrid", [query, v, scope.rawValue, limit]))
        }
    }

    /// Option B: the vector pass was done natively (see `VectorScorer`); `scores` are Float32 row scores per corpus.
    public func hybridFromRowScores(_ query: String, papersScores: Data?, notesScores: Data?, scope: Scope,
                                    limit: Int) async throws -> [ResultVM] {
        try autoreleasepool {
            let ctx = try requireContext()
            let p: Any = try papersScores.map { try Self.buffer($0, in: ctx) } ?? NSNull()
            let n: Any = try notesScores.map { try Self.buffer($0, in: ctx) } ?? NSNull()
            return try Self.decode([ResultVM].self, from: try call("hybridFromRowScores", [query, p, n, scope.rawValue, limit]))
        }
    }

    public func recent(limit: Int) async throws -> [ResultVM] {
        try callDecode([ResultVM].self, "recent", [limit])
    }

    private func callDecode<T: Decodable>(_ type: T.Type, _ method: String, _ args: [Any]) throws -> T {
        try autoreleasepool { try Self.decode(T.self, from: try call(method, args)) }
    }

    /// Diagnostics: the current engine's JavaScriptCore heap (after an optional synchronous full GC).
    public func heapStatistics(collectFirst: Bool = false) -> [String: Double] {
        guard let engine else { return [:] }
        return autoreleasepool {
            if collectFirst { JSCPrivate.collectNow(engine.ctx) }
            return JSCPrivate.heapStatistics(engine.ctx)
        }
    }

    public func objectTypeCounts() -> [(String, Int)] {
        guard let engine else { return [] }
        return autoreleasepool { JSCPrivate.collectNow(engine.ctx); return JSCPrivate.objectTypeCounts(engine.ctx) }
    }

    /// Diagnostics: runs JavaScript in the current engine and returns its string result.
    public func evaluateForDiagnostics(_ script: String) -> String {
        guard let engine else { return "" }
        return autoreleasepool { engine.ctx.evaluateScript(script)?.toString() ?? "" }
    }

    public func lookup(ids: [String]) async throws -> [ResultVM] {
        try callDecode([ResultVM].self, "lookup", [ids])
    }

    // MARK: JavaScriptCore plumbing

    private func requireContext() throws -> JSContext {
        guard let engine else { throw RankerError("no index loaded") }
        return engine.ctx
    }

    private func call(_ method: String, _ args: [Any]) throws -> JSValue {
        guard let engine else { throw RankerError("no index loaded") }
        _ = engine.exceptions.take()
        let result = engine.api.invokeMethod(method, withArguments: args)
        if let e = engine.exceptions.take() { throw e }
        guard let result else { throw RankerError("\(method) returned nothing") }
        return result
    }

    private static func decode<T: Decodable>(_ type: T.Type, from value: JSValue) throws -> T {
        guard let text = value.toString() else { throw RankerError("ranker returned no JSON") }
        do { return try JSONDecoder().decode(T.self, from: Data(text.utf8)) }
        catch { throw RankerError("ranker returned JSON that does not match \(T.self): \(error)") }
    }

    private static func part(_ files: CorpusFiles, in ctx: JSContext) throws -> JSValue {
        let obj = JSValue(newObjectIn: ctx)!
        // JSON goes in as strings: decoding 15 MB of UTF-8 natively takes milliseconds, in JavaScript about 0.6 s.
        obj.setValue(String(decoding: files.manifest, as: UTF8.self), forProperty: "manifest")
        obj.setValue(String(decoding: files.papers, as: UTF8.self), forProperty: "papers")
        obj.setValue(String(decoding: files.chunks, as: UTF8.self), forProperty: "chunks")
        obj.setValue(try files.vectors.map { try buffer($0, in: ctx) } ?? NSNull(), forProperty: "vectors")
        return obj
    }

    /// An ArrayBuffer over the bytes of `data` without copying (memory-mapped files stay mapped). The bytes are kept
    /// alive by the buffer's deallocator until JavaScriptCore collects it.
    static func buffer(_ data: Data, in ctx: JSContext) throws -> JSValue {
        if data.isEmpty { return ctx.evaluateScript("new ArrayBuffer(0)") }
        let ns = data as NSData
        let retained = Unmanaged.passRetained(ns)
        var exception: JSValueRef?
        guard let ref = JSObjectMakeArrayBufferWithBytesNoCopy(
            ctx.jsGlobalContextRef, UnsafeMutableRawPointer(mutating: ns.bytes), ns.length,
            { _, info in if let info { Unmanaged<NSData>.fromOpaque(info).release() } },
            retained.toOpaque(), &exception)
        else {
            retained.release()
            throw RankerError("could not create an ArrayBuffer of \(data.count) bytes")
        }
        return JSValue(jsValueRef: ref, in: ctx)
    }

    private static func copyBuffer(_ floats: [Float], in ctx: JSContext) throws -> JSValue {
        let bytes = floats.count * MemoryLayout<Float>.size
        guard bytes > 0, let mem = malloc(bytes) else { return ctx.evaluateScript("new ArrayBuffer(0)") }
        floats.withUnsafeBytes { mem.copyMemory(from: $0.baseAddress!, byteCount: bytes) }
        var exception: JSValueRef?
        guard let ref = JSObjectMakeArrayBufferWithBytesNoCopy(
            ctx.jsGlobalContextRef, mem, bytes, { bytes, _ in free(bytes) }, nil, &exception)
        else {
            free(mem)
            throw RankerError("could not create an ArrayBuffer for the query vector")
        }
        return JSValue(jsValueRef: ref, in: ctx)
    }
}
