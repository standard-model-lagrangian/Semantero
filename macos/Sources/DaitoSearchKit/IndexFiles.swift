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

public enum IndexFiles {
    public static func corpusDirs(vault: URL) -> (papers: URL, notes: URL) {
        let planner = vault.appendingPathComponent(".planner", isDirectory: true)
        return (planner.appendingPathComponent("search", isDirectory: true),
                planner.appendingPathComponent("notes", isDirectory: true))
    }

    /// `content_hash` (else `built_at`) of a corpus, reading only manifest.json. Nil when there is none.
    public static func manifestHash(of dir: URL) -> String? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("manifest.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return (json["content_hash"] as? String) ?? (json["built_at"] as? String)
    }

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
