import Foundation

/// The files of one corpus folder (`.planner/search` or `.planner/notes`). `vectors` is memory-mapped, not copied.
public struct CorpusFiles: Sendable {
    public let dir: URL
    public let manifest: Data
    public let papers: Data
    public let chunks: Data
    public let vectors: Data?
    public let contentHash: String
}

/// The parts of a corpus's `manifest.json` (written by planner/searchindex.py and notesindex.py) that the app reads. Every
/// field is optional, and one of an unexpected type reads as absent rather than making the whole manifest unreadable.
public struct IndexManifest: Decodable, Sendable, Equatable {
    public var contentHash: String?
    public var builtAt: String?
    /// "pplx" for an index built by the pplx-embed-v2-late profile; absent for Ollama.
    public var backend: String?
    public var backendURL: String?
    /// Zotero's storage folder, against which relative paper file paths resolve.
    public var zoteroStorage: String?

    public init(contentHash: String? = nil, builtAt: String? = nil, backend: String? = nil, backendURL: String? = nil,
                zoteroStorage: String? = nil) {
        self.contentHash = contentHash; self.builtAt = builtAt; self.backend = backend; self.backendURL = backendURL
        self.zoteroStorage = zoteroStorage
    }

    private enum CodingKeys: String, CodingKey {
        case contentHash = "content_hash", builtAt = "built_at", backend, backendURL = "backend_url",
             zoteroStorage = "zotero_storage"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func string(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        self.init(contentHash: string(.contentHash), builtAt: string(.builtAt), backend: string(.backend),
                  backendURL: string(.backendURL), zoteroStorage: string(.zoteroStorage))
    }

    /// Nil when `data` is not a JSON object.
    public init?(data: Data) {
        guard let m = try? JSONDecoder().decode(IndexManifest.self, from: data) else { return nil }
        self = m
    }

    /// `<dir>/manifest.json`; nil when it is missing or not a JSON object.
    public static func read(dir: URL) -> IndexManifest? {
        (try? Data(contentsOf: dir.appendingPathComponent("manifest.json"))).flatMap(IndexManifest.init(data:))
    }

    /// What identifies a build: `content_hash`, else `built_at`.
    public var hash: String? { contentHash ?? builtAt }
}

public enum IndexFiles {
    public static func corpusDirs(vault: URL) -> (papers: URL, notes: URL) {
        let planner = vault.appendingPathComponent(".planner", isDirectory: true)
        return (planner.appendingPathComponent("search", isDirectory: true),
                planner.appendingPathComponent("notes", isDirectory: true))
    }

    /// `content_hash` (else `built_at`) of a corpus, reading only manifest.json. Nil when there is none.
    public static func manifestHash(of dir: URL) -> String? { IndexManifest.read(dir: dir)?.hash }

    /// The indexer writes `<name>.tmp/` and swaps it in (`<name>.old/` while it does). While either exists the
    /// folder may be half-written or missing; the caller keeps what it has and tries again.
    public static func swapInProgress(dir: URL) -> Bool {
        let fm = FileManager.default
        let parent = dir.deletingLastPathComponent()
        let name = dir.lastPathComponent
        return fm.fileExists(atPath: parent.appendingPathComponent("\(name).tmp").path)
            || fm.fileExists(atPath: parent.appendingPathComponent("\(name).old").path)
    }

    public static func read(dir: URL) throws -> CorpusFiles? {
        let manifestURL = dir.appendingPathComponent("manifest.json")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else { return nil }
        let manifest = try Data(contentsOf: manifestURL)
        let papers = try Data(contentsOf: dir.appendingPathComponent("papers.json"))
        let chunks = try Data(contentsOf: dir.appendingPathComponent("chunks.json"))
        let vectorsURL = dir.appendingPathComponent("vectors.f32")
        let vectors = FileManager.default.fileExists(atPath: vectorsURL.path)
            ? try Data(contentsOf: vectorsURL, options: .alwaysMapped) : nil
        let hash = manifestHash(of: dir) ?? ""
        return CorpusFiles(dir: dir, manifest: manifest, papers: papers, chunks: chunks, vectors: vectors, contentHash: hash)
    }
}
