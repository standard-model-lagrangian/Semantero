import ApplicationServices
import DaitoSearchKit
import SwiftUI

struct SettingsView: View {
    let model: AppModel
    @State private var vault = ""
    @State private var hotkey = ""
    @State private var ollama = ""
    @State private var limit = 15
    @State private var restore = false
    @State private var spotPapers = true
    @State private var spotTitles = true
    @State private var spotText = false
    @State private var login = true
    @State private var hotkeyError: String?

    var body: some View {
        Form {
            Section("Search") {
                TextField("Obsidian vault", text: $vault).onSubmit(save)
                TextField("Hotkey (e.g. ⌥Space)", text: $hotkey).onSubmit(save)
                if let hotkeyError { Text(hotkeyError).foregroundStyle(.red).font(.caption) }
                TextField("Ollama URL", text: $ollama).onSubmit(save)
                Stepper("Results: \(limit)", value: $limit, in: 5...30)
            }
            Section("Pasting") {
                Toggle("Restore the clipboard after pasting", isOn: $restore)
                HStack {
                    Text(AXIsProcessTrusted() ? "Accessibility: allowed" : "Accessibility: not allowed (⌘↵ copies only)")
                    Spacer()
                    Button("Open System Settings") { NSWorkspace.shared.open(ActionExecutor.accessibilitySettingsURL) }
                }
            }
            Section("Spotlight") {
                Toggle("Add papers (title, authors, citekey)", isOn: $spotPapers)
                Toggle("Add note titles", isOn: $spotTitles)
                Toggle("Add note text (Spotlight then ranks on it)", isOn: $spotText)
            }
            Section("General") {
                Toggle("Launch at login", isOn: $login)
                Text(model.statusLine).font(.caption).foregroundStyle(.secondary)
            }
            Button("Save") { save() }.keyboardShortcut(.defaultAction)
        }
        .formStyle(.grouped).frame(width: 520).padding()
        .onAppear(perform: load)
    }

    private func load() {
        let s = model.settings
        vault = s.vaultPath; hotkey = s.hotkey; ollama = s.ollamaURL; limit = s.resultLimit; restore = s.restoreClipboard
        spotPapers = s.spotlightPapers; spotTitles = s.spotlightNoteTitles; spotText = s.spotlightNoteText; login = s.launchAtLogin
    }

    private func save() {
        let s = model.settings
        let before = SettingsSnapshot(s)
        hotkeyError = nil
        do { _ = try HotkeySpec(parsing: hotkey) } catch { hotkeyError = "Not a valid hotkey: use modifiers and a key, like ⌥Space"; return }
        s.vaultPath = (vault as NSString).expandingTildeInPath; s.hotkey = hotkey; s.ollamaURL = ollama; s.resultLimit = limit
        s.restoreClipboard = restore; s.spotlightPapers = spotPapers; s.spotlightNoteTitles = spotTitles
        s.spotlightNoteText = spotText; s.launchAtLogin = login
        model.applySettings(from: before)
    }
}
