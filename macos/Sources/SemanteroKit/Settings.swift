import Foundation

/// Typed access to the app's preferences. Defaults match docs/LAUNCHER_SPEC.md.
public final class SettingsStore: @unchecked Sendable {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public static let defaultVaultPath = ("~/Documents/Obsidian Vault" as NSString).expandingTildeInPath

    public var vaultPath: String {
        get { defaults.string(forKey: "vaultPath") ?? Self.defaultVaultPath }
        set { defaults.set(newValue, forKey: "vaultPath") }
    }
    public var hotkey: String {
        get { defaults.string(forKey: "hotkey") ?? "⌥Space" }
        set { defaults.set(newValue, forKey: "hotkey") }
    }
    public var ollamaURL: String {
        get { defaults.string(forKey: "ollamaURL") ?? "http://127.0.0.1:11434" }
        set { defaults.set(newValue, forKey: "ollamaURL") }
    }
    /// How long Ollama keeps the embedding model loaded after a search (its process holds ~400 MB while loaded). The panel
    /// warms the model when it opens, so a cold model mostly costs nothing noticeable.
    public var ollamaKeepAlive: String {
        get { defaults.string(forKey: "ollamaKeepAlive") ?? "5m" }
        set { defaults.set(newValue, forKey: "ollamaKeepAlive") }
    }
    public var resultLimit: Int {
        get { defaults.object(forKey: "resultLimit") as? Int ?? 15 }
        set { defaults.set(newValue, forKey: "resultLimit") }
    }
    public var restoreClipboard: Bool {
        get { defaults.object(forKey: "restoreClipboard") as? Bool ?? false }
        set { defaults.set(newValue, forKey: "restoreClipboard") }
    }
    public var spotlightPapers: Bool {
        get { defaults.object(forKey: "spotlightPapers") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "spotlightPapers") }
    }
    public var spotlightNoteTitles: Bool {
        get { defaults.object(forKey: "spotlightNoteTitles") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "spotlightNoteTitles") }
    }
    /// Off by default: donating note text makes Spotlight rank on it and duplicates results.
    public var spotlightNoteText: Bool {
        get { defaults.object(forKey: "spotlightNoteText") as? Bool ?? false }
        set { defaults.set(newValue, forKey: "spotlightNoteText") }
    }
    public var launchAtLogin: Bool {
        get { defaults.object(forKey: "launchAtLogin") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "launchAtLogin") }
    }
    public var scope: Scope {
        get { Scope(rawValue: defaults.string(forKey: "scope") ?? "") ?? .all }
        set { defaults.set(newValue.rawValue, forKey: "scope") }
    }
    public var showDetail: Bool {
        get { defaults.object(forKey: "showDetail") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "showDetail") }
    }
}

/// The settings that matter to the running app, compared before and after a save to decide what to redo.
public struct SettingsSnapshot: Equatable, Sendable {
    public var vaultPath: String
    public var hotkey: String
    public var ollamaURL: String
    public var ollamaKeepAlive: String
    public var resultLimit: Int
    public var spotlight: [Bool]
    public var launchAtLogin: Bool

    public init(_ s: SettingsStore) {
        vaultPath = s.vaultPath; hotkey = s.hotkey; ollamaURL = s.ollamaURL; ollamaKeepAlive = s.ollamaKeepAlive
        resultLimit = s.resultLimit
        spotlight = [s.spotlightPapers, s.spotlightNoteTitles, s.spotlightNoteText]; launchAtLogin = s.launchAtLogin
    }
}

public enum SettingsEffect: Hashable, Sendable {
    /// New vault: new reloader and file watcher, load from scratch, re-sync Spotlight.
    case reopenVault
    /// New Ollama URL: rebuild the query embedder from the loaded index's model.
    case reconfigureEmbedding
    case applyResultLimit
    case registerHotkey
    case syncSpotlight
    case applyLoginItem

    public static func between(_ old: SettingsSnapshot, _ new: SettingsSnapshot) -> Set<SettingsEffect> {
        var out = Set<SettingsEffect>()
        if old.vaultPath != new.vaultPath { out.insert(.reopenVault); out.insert(.syncSpotlight) }
        if old.ollamaURL != new.ollamaURL || old.ollamaKeepAlive != new.ollamaKeepAlive { out.insert(.reconfigureEmbedding) }
        if old.resultLimit != new.resultLimit { out.insert(.applyResultLimit) }
        if old.hotkey != new.hotkey { out.insert(.registerHotkey) }
        if old.spotlight != new.spotlight { out.insert(.syncSpotlight) }
        if old.launchAtLogin != new.launchAtLogin { out.insert(.applyLoginItem) }
        return out
    }
}

extension SettingsStore {
    /// Every preference key the app stores.
    public static let keys = ["vaultPath", "hotkey", "ollamaURL", "ollamaKeepAlive", "resultLimit", "restoreClipboard",
                              "spotlightPapers", "spotlightNoteTitles", "spotlightNoteText", "launchAtLogin", "scope", "showDetail"]
    /// The app was called Daito Search, with this bundle id, until 24 Oct 2026.
    public static let legacyDomain = "dev.daito.search"
    static let importedKey = "importedLegacySettings"

    /// Copies the settings of the app's old identity (`legacy`, the `dev.daito.search` domain) into `defaults`, once:
    /// only keys this app stores, and nothing it has already set itself. Returns the keys copied.
    @discardableResult
    public static func importLegacySettings(_ legacy: [String: Any]?, into defaults: UserDefaults) -> [String] {
        guard !defaults.bool(forKey: importedKey) else { return [] }
        defaults.set(true, forKey: importedKey)
        guard let legacy else { return [] }
        let copied = keys.filter { legacy[$0] != nil && defaults.object(forKey: $0) == nil }
        for key in copied { defaults.set(legacy[key], forKey: key) }
        return copied
    }
}
