import CoreSpotlight
import CryptoKit
import Foundation

public struct SearchableItem: Sendable, Equatable {
    public let id: String
    public let domain: String            // "papers" | "notes"
    public let title: String
    public let description: String
    public let keywords: [String]
    public let contentURL: URL?
    public let textContent: String?

    var fingerprint: String {
        let parts = [id, domain, title, description, keywords.joined(separator: "\u{1}"), contentURL?.absoluteString ?? "", textContent ?? ""]
        return SHA256.hash(data: Data(parts.joined(separator: "\u{0}").utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public protocol SpotlightIndexing: Sendable {
    func index(_ items: [SearchableItem]) async throws
    func delete(ids: [String]) async throws
    func deleteDomain(_ domain: String) async throws
}

public struct SpotlightSettings: Sendable, Equatable {
    public var papers: Bool
    public var noteTitles: Bool
    public var noteText: Bool
    public init(papers: Bool = true, noteTitles: Bool = true, noteText: Bool = false) {
        self.papers = papers; self.noteTitles = noteTitles; self.noteText = noteText
    }
}

public struct SyncReport: Sendable, Equatable {
    public var indexed: Int
    public var deleted: Int
}

/// Keeps Core Spotlight in step with the indexes: one entry per paper (title, authors, citekey, tags) and per note
/// (title, tags, aliases), found by ⌘Space and opened through the app. Abstracts are never donated.
public actor SpotlightDonor {
    private struct PaperEntry: Decodable {
        let key: String; let citekey: String; let title: String
        let authors: [String]; let year: Int?; let journal: String?
        let tags: [String]; let collections: [String]
        let pdfs: [Att]?
        struct Att: Decodable { let file: String? }
    }
    private struct NoteEntry: Decodable {
        let key: String; let title: String; let path: String?
        let tags: [String]; let collections: [String]; let mtime: Int?
    }
    private struct ChunkEntry: Decodable { let paper: Int; let text: String }

    private let index: SpotlightIndexing
    private let stateURL: URL

    public init(index: SpotlightIndexing, stateURL: URL) { self.index = index; self.stateURL = stateURL }

    public func sync(papers: Data?, notes: Data?, chunks: Data?, settings: SpotlightSettings, zoteroStorage: String?,
                     vault: String?) async throws -> SyncReport {
        var wanted: [SearchableItem] = []
        if settings.papers, let papers, let list = try? JSONDecoder().decode([PaperEntry].self, from: papers) {
            wanted += list.map { Self.item($0, storage: zoteroStorage) }
        }
        if settings.noteTitles, let notes, let list = try? JSONDecoder().decode([NoteEntry].self, from: notes) {
            var text: [Int: String] = [:]
            if settings.noteText, let chunks, let cs = try? JSONDecoder().decode([ChunkEntry].self, from: chunks) {
                for c in cs { text[c.paper, default: ""] += (text[c.paper] == nil ? "" : " ") + c.text }
            }
            wanted += list.enumerated().map { Self.item($1, vault: vault, text: settings.noteText ? (text[$0] ?? "") : nil) }
        }

        var state = (try? JSONDecoder().decode([String: String].self, from: Data(contentsOf: stateURL))) ?? [:]
        var report = SyncReport(indexed: 0, deleted: 0)

        // Turned-off domains are deleted wholesale.
        for (domain, on) in [("papers", settings.papers), ("notes", settings.noteTitles)] where !on {
            let ids = state.keys.filter { $0.hasPrefix(domain == "papers" ? "P:" : "N:") }
            if !ids.isEmpty {
                try await index.deleteDomain(domain)
                ids.forEach { state[$0] = nil }
                report.deleted += ids.count
            }
        }

        let wantedIDs = Set(wanted.map(\.id))
        let removed = state.keys.filter { !wantedIDs.contains($0) }
        if !removed.isEmpty {
            try await index.delete(ids: removed)
            removed.forEach { state[$0] = nil }
            report.deleted += removed.count
        }
        let changed = wanted.filter { state[$0.id] != $0.fingerprint }
        for batch in stride(from: 0, to: changed.count, by: 100).map({ Array(changed[$0..<min($0 + 100, changed.count)]) }) {
            try await index.index(batch)
            batch.forEach { state[$0.id] = $0.fingerprint }
            report.indexed += batch.count
        }
        try FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: stateURL, options: .atomic)
        return report
    }

    private static func authors(_ a: [String]) -> String {
        let a = a.filter { !$0.isEmpty }
        switch a.count {
        case 0: return ""
        case 1: return a[0]
        case 2: return "\(a[0]) & \(a[1])"
        default: return "\(a[0]) et al."
        }
    }

    private static func item(_ p: PaperEntry, storage: String?) -> SearchableItem {
        let desc = [authors(p.authors), p.year.map(String.init) ?? "", p.journal ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        var url: URL?
        if let file = p.pdfs?.compactMap(\.file).first {
            if file.hasPrefix("/") { url = URL(fileURLWithPath: file) }
            else if let storage { url = URL(fileURLWithPath: storage).appendingPathComponent(file) }
        }
        return SearchableItem(id: "P:\(p.key)", domain: "papers", title: p.title, description: desc,
                              keywords: [p.citekey] + p.tags + p.collections, contentURL: url, textContent: nil)
    }

    private static func item(_ n: NoteEntry, vault: String?, text: String?) -> SearchableItem {
        let folder = n.collections.first ?? ""
        let modified = n.mtime.map { Date(timeIntervalSince1970: TimeInterval($0)).formatted(.iso8601.year().month().day()) } ?? ""
        let desc = [folder, modified].filter { !$0.isEmpty }.joined(separator: " · ")
        let url = (vault != nil && n.path != nil) ? URL(fileURLWithPath: vault!).appendingPathComponent(n.path!) : nil
        return SearchableItem(id: "N:\(n.key)", domain: "notes", title: n.title, description: desc, keywords: n.tags,
                              contentURL: url, textContent: text)
    }
}

/// The real thing: a named CSSearchableIndex.
public struct CoreSpotlightIndex: SpotlightIndexing {
    private let name: String
    public init(name: String = "daito") { self.name = name }

    public func index(_ items: [SearchableItem]) async throws {
        let searchable = items.map { item -> CSSearchableItem in
            let attrs = CSSearchableItemAttributeSet(contentType: .content)
            attrs.title = item.title
            attrs.contentDescription = item.description
            attrs.keywords = item.keywords
            attrs.contentURL = item.contentURL
            attrs.textContent = item.textContent
            return CSSearchableItem(uniqueIdentifier: item.id, domainIdentifier: item.domain, attributeSet: attrs)
        }
        try await CSSearchableIndex(name: name).indexSearchableItems(searchable)
    }
    public func delete(ids: [String]) async throws {
        try await CSSearchableIndex(name: name).deleteSearchableItems(withIdentifiers: ids)
    }
    public func deleteDomain(_ domain: String) async throws {
        try await CSSearchableIndex(name: name).deleteSearchableItems(withDomainIdentifiers: [domain])
    }
}
