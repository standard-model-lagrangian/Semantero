import Carbon.HIToolbox
import Foundation
import Testing
@testable import SemanteroKit

@Suite("Hotkey, shortcuts, settings")
struct HotkeyShortcutsSettingsTests {
    // S30
    @Test func hotkeyStringRoundTripsToCarbonCodeAndModifiers() throws {
        let a = try HotkeySpec(parsing: "⌥Space")
        #expect(a.keyCode == UInt32(kVK_Space) && a.modifiers == UInt32(optionKey))
        #expect(a.description == "⌥Space")
        let b = try HotkeySpec(parsing: "⌃⌥⌘K")
        #expect(b.keyCode == UInt32(kVK_ANSI_K) && b.modifiers == UInt32(controlKey | optionKey | cmdKey))
        #expect(b.description == "⌃⌥⌘K")
        let c = try HotkeySpec(parsing: "cmd+shift+f")
        #expect(c.keyCode == UInt32(kVK_ANSI_F) && c.modifiers == UInt32(cmdKey | shiftKey))
        for text in ["⌥Space", "⌃⌥⌘K", "⇧⌘F", "⌥F5", "⌘1"] {
            let spec = try HotkeySpec(parsing: text)
            #expect(try HotkeySpec(parsing: spec.description) == spec, "\(text) → \(spec.description)")
        }
        #expect(throws: HotkeySpec.ParseError.noModifier) { try HotkeySpec(parsing: "Space") }
        #expect(throws: HotkeySpec.ParseError.noKey) { try HotkeySpec(parsing: "⌥") }
        #expect(throws: HotkeySpec.ParseError.unknownKey("foo")) { try HotkeySpec(parsing: "⌥Foo") }
        #expect(throws: (any Error).self) { try HotkeySpec(parsing: "") }
    }

    // S31
    @Test func keyMapFromShortcutsJsonResolvesEveryKeyWithNoDuplicates() throws {
        let table = try ShortcutTable(url: Repo.shortcuts)
        #expect(table.actions.count == 11)
        var seen = Set<KeyChord>()
        for a in table.actions {
            let chord = try #require(table.chord(for: a.id), "\(a.id) has an unparseable key \(a.key)")
            #expect(table.actionID(for: chord) == a.id)
            #expect(seen.insert(chord).inserted, "duplicate chord \(chord)")
            #expect(!table.reserved.contains(chord), "\(a.id) uses a reserved key")
        }
        #expect(table.actionID(for: KeyChord(key: "return")) == "open")
        #expect(table.actionID(for: KeyChord(key: "return", command: true)) == "paste-file")
        #expect(table.actionID(for: KeyChord(key: "return", command: true, shift: true)) == "paste-passage")
        #expect(table.actionID(for: KeyChord(key: "c", command: true, option: true)) == "copy-passage")
        #expect(table.actionID(for: KeyChord(key: ".", command: true, shift: true)) == "copy-path")
        #expect(table.actionID(for: KeyChord(key: "k", command: true)) == nil)   // ⌘K is the action menu itself
        #expect(KeyChord(parsing: "cmd+shift+return") == KeyChord(key: "Return", command: true, shift: true))
    }

    // S32
    @Test func settingsDefaultsMatchTheSpec() throws {
        let scratch = ScratchDefaults("defaults")
        defer { scratch.remove() }
        let s = SettingsStore(defaults: scratch.defaults)
        #expect(s.hotkey == "⌥Space")
        #expect(s.ollamaURL == "http://127.0.0.1:11434")
        #expect(s.ollamaKeepAlive == "5m")
        #expect(s.resultLimit == 15)
        #expect(s.restoreClipboard == false)
        #expect(s.spotlightPapers == true && s.spotlightNoteTitles == true && s.spotlightNoteText == false)
        #expect(s.launchAtLogin == true)
        #expect(s.scope == .all)
        #expect(s.showDetail == true)
        #expect(s.vaultPath.hasSuffix("/Documents/Obsidian Vault"))
        s.resultLimit = 20; s.restoreClipboard = true
        let again = SettingsStore(defaults: scratch.defaults)
        #expect(again.resultLimit == 20 && again.restoreClipboard)
    }

    @Test func settingsComeOverFromDaitoSearchOnceAndNeverOverwrite() throws {
        let scratch = ScratchDefaults("effects")
        defer { scratch.remove() }
        let d = scratch.defaults
        d.set(25, forKey: "resultLimit")                                     // already set under the new name
        let legacy: [String: Any] = ["hotkey": "⌃⌥Space", "resultLimit": 8, "spotlightNoteText": true,
                                     "NSWindow Frame Settings": "0 0 10 10"]  // not ours: left behind
        let copied = SettingsStore.importLegacySettings(legacy, into: d)
        #expect(Set(copied) == ["hotkey", "spotlightNoteText"])
        let s = SettingsStore(defaults: d)
        #expect(s.hotkey == "⌃⌥Space" && s.spotlightNoteText && s.resultLimit == 25)
        #expect(d.object(forKey: "NSWindow Frame Settings") == nil)
        s.hotkey = "⌥Space"
        #expect(SettingsStore.importLegacySettings(legacy, into: d).isEmpty, "only once")
        #expect(s.hotkey == "⌥Space")
        #expect(SettingsStore.legacyDomain == "dev.daito.search")
    }
}

@Suite("Settings take effect without a restart")
struct SettingsEffectTests {
    @Test func eachChangedSettingMapsToWhatMustBeRedone() throws {
        let scratch = ScratchDefaults("legacy-import")
        defer { scratch.remove() }
        let s = SettingsStore(defaults: scratch.defaults)
        let before = SettingsSnapshot(s)
        #expect(SettingsEffect.between(before, SettingsSnapshot(s)).isEmpty)
        s.vaultPath = "/elsewhere"; s.ollamaURL = "http://127.0.0.1:9999"; s.resultLimit = 20; s.hotkey = "⌃⌥Space"
        s.spotlightNoteText = true; s.launchAtLogin = false
        #expect(SettingsEffect.between(before, SettingsSnapshot(s)) ==
                [.reopenVault, .syncSpotlight, .reconfigureEmbedding, .applyResultLimit, .registerHotkey, .applyLoginItem])
        let mid = SettingsSnapshot(s)
        s.ollamaKeepAlive = "30m"
        #expect(SettingsEffect.between(mid, SettingsSnapshot(s)) == [.reconfigureEmbedding])
        s.ollamaKeepAlive = "5m"
        s.spotlightPapers = false
        #expect(SettingsEffect.between(mid, SettingsSnapshot(s)) == [.syncSpotlight])
    }

    @Test func newResultLimitIsUsedForTheNextSearchAndReRunsTheQuery() async {
        let ranker = FakeRanker(), log = UpdateLog()
        let c = QueryController(ranker: ranker, sleeper: FakeSleeper(), limit: 15) { log.add($0) }
        await c.setQuery("organoid")
        await log.wait { $0.count == 1 }
        await c.setLimit(20)
        await log.wait { $0.count == 2 }
        #expect(ranker.limits == [15, 20])
        #expect(log.all.last?.query == "organoid")
    }
}
