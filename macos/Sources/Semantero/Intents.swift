import AppIntents
import SemanteroKit
import Foundation

/// The Spotlight action "Search Everything": type the action's name in ⌘Space, press Tab, type a query; the entity
/// query below answers live from the running app's engine, and choosing a result opens it. (Spike S3 checks that
/// Spotlight really calls this per keystroke.)
struct SearchResultEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Result"
    static let defaultQuery = SearchResultQuery()

    var id: String
    var title: String
    var subtitle: String
    var symbolName: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: subtitle.isEmpty ? nil : "\(subtitle)",
                              image: .init(systemName: symbolName))
    }

    init(_ vm: ResultVM) {
        id = vm.id; title = vm.title; subtitle = vm.subtitle.isEmpty ? vm.accessory : vm.subtitle
        symbolName = vm.kind == "paper" ? "doc.text" : vm.kind == "daily" ? "calendar" : "note.text"
    }
}

struct SearchResultQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [SearchResultEntity] {
        guard let service = await IntentBridge.shared.service else { return [] }
        return await service.results(for: identifiers).map(SearchResultEntity.init)
    }

    func entities(matching string: String) async throws -> [SearchResultEntity] {
        guard let service = await IntentBridge.shared.service else { return [] }
        return await service.matching(string).map(SearchResultEntity.init)
    }

    func suggestedEntities() async throws -> [SearchResultEntity] {
        guard let service = await IntentBridge.shared.service else { return [] }
        return await service.suggested().map(SearchResultEntity.init)
    }
}

struct OpenResultIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Search Result"
    static let description = IntentDescription("Opens a paper in Zotero or a note in Obsidian.")
    static let openAppWhenRun = false

    @Parameter(title: "Result") var item: SearchResultEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        AppModel.shared.openSpotlightResult(id: item.id)
        return .result()
    }
}

struct RevealResultIntent: AppIntent {
    static let title: LocalizedStringResource = "Show Result in Finder"
    static let openAppWhenRun = false
    @Parameter(title: "Result") var item: SearchResultEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        try await run(action: "reveal", id: item.id)
        return .result()
    }
}

struct CopyResultFileIntent: AppIntent {
    static let title: LocalizedStringResource = "Copy Result File"
    static let openAppWhenRun = false
    @Parameter(title: "Result") var item: SearchResultEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        try await run(action: "copy-file", id: item.id)
        return .result()
    }
}

@MainActor
private func run(action: String, id: String) async throws {
    guard let service = AppModel.shared.intentService, let vm = await service.results(for: [id]).first else { return }
    AppModel.shared.run(action, on: vm)
}

struct SemanteroShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenResultIntent(), phrases: ["Search Everything in \(.applicationName)", "Search \(.applicationName)"],
                    shortTitle: "Search Everything", systemImageName: "magnifyingglass")
    }
}
