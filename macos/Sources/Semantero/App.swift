import AppKit
import SemanteroKit
import SwiftUI

@main
struct SemanteroApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() { JSCRanker.configureProcess() }

    var body: some Scene {
        MenuBarExtra("Semantero", systemImage: "magnifyingglass") {
            MenuContent(model: AppModel.shared)
        }
        Settings { SettingsView(model: AppModel.shared) }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        AppModel.shared.start()
    }
}

struct MenuContent: View {
    let model: AppModel
    @Environment(\.openSettings) private var openSettings
    var body: some View {
        Button("Search  \(model.settings.hotkey)") { model.panel.show() }
        Button("Reload Indexes") { Task { await model.reloadIndexes() } }
        Divider()
        Text(model.statusLine)
        if let s = model.status {
            if let p = s.papers { Text("Papers: built \(p.builtAt ?? "?")" + (p.semantic ? "" : ", keyword only")) }
            if let n = s.notes { Text("Notes: built \(n.builtAt ?? "?")" + (n.semantic ? "" : ", keyword only")) }
            ForEach(s.flags, id: \.self) { Text("⚠ \($0)") }
        }
        Divider()
        Button("Settings…") {
            // A menu-bar-only app is never active, so its Settings window would open behind other apps.
            NSApplication.shared.activate()
            openSettings()
        }.keyboardShortcut(",")
        Button("Quit Semantero") { NSApplication.shared.terminate(nil) }.keyboardShortcut("q")
    }
}
