import Foundation

public enum Scope: String, Codable, Sendable, CaseIterable {
    case all, papers, notes
}

public struct DetailRow: Codable, Sendable, Equatable {
    public let label: String
    public let value: String
}

/// Mirror of the TypeScript `ResultVM`. The UI only renders this and runs actions by id.
public struct ResultVM: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String            // paper | note | daily | litnote
    public let title: String
    public let subtitle: String
    public let accessory: String
    public let snippet: String
    /// UTF-16 [start, end) ranges of `snippet` to show in bold.
    public let snippetBold: [[Int]]
    public let hasNote: Bool
    public let filePath: String?
    public let openUrl: String
    public let openLabel: String
    public let noteUrl: String?
    public let selectUrl: String?
    public let citation: String
    public let wikilink: String
    public let actions: [String]
    public let detail: [DetailRow]
    public let source: String          // keyword | semantic | both

    public init(
        id: String, kind: String = "note", title: String = "", subtitle: String = "", accessory: String = "",
        snippet: String = "", snippetBold: [[Int]] = [], hasNote: Bool = false, filePath: String? = nil,
        openUrl: String = "", openLabel: String = "Open", noteUrl: String? = nil, selectUrl: String? = nil,
        citation: String = "", wikilink: String = "", actions: [String] = ["open"], detail: [DetailRow] = [],
        source: String = "keyword"
    ) {
        self.id = id; self.kind = kind; self.title = title; self.subtitle = subtitle; self.accessory = accessory
        self.snippet = snippet; self.snippetBold = snippetBold; self.hasNote = hasNote; self.filePath = filePath
        self.openUrl = openUrl; self.openLabel = openLabel; self.noteUrl = noteUrl; self.selectUrl = selectUrl
        self.citation = citation; self.wikilink = wikilink; self.actions = actions; self.detail = detail
        self.source = source
    }
}

public struct CorpusStatus: Codable, Sendable, Equatable {
    public let count: Int
    public let builtAt: String?
    public let semantic: Bool
    public let reason: String?
}

public struct RankerStatus: Codable, Sendable, Equatable {
    public let papers: CorpusStatus?
    public let notes: CorpusStatus?
    public let flags: [String]
    public let model: String?
    public let dims: Int?
    public let queryInstruction: String?
    /// Milliseconds `load` spent decoding bytes, parsing JSON and building the indexes (diagnostics; only after `load`).
    public let timings: [String: Double]?

    public init(papers: CorpusStatus? = nil, notes: CorpusStatus? = nil, flags: [String] = [], model: String? = nil,
                dims: Int? = nil, queryInstruction: String? = nil, timings: [String: Double]? = nil) {
        self.papers = papers; self.notes = notes; self.flags = flags; self.model = model; self.dims = dims
        self.queryInstruction = queryInstruction; self.timings = timings
    }

    public var anySemantic: Bool { (papers?.semantic ?? false) || (notes?.semantic ?? false) }
}

public struct RankerError: Error, Sendable, Equatable, CustomStringConvertible {
    public let message: String
    public let stack: String?
    public init(_ message: String, stack: String? = nil) { self.message = message; self.stack = stack }
    public var description: String { stack.map { "\(message)\n\($0)" } ?? message }
}
