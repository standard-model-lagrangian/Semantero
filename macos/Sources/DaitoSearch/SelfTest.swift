import AppKit
import DaitoSearchKit
import Foundation

/// `DAITO_SELFTEST=<json path>`: drives the real panel with synthetic key events (sent straight to the panel window,
/// so no Accessibility permission is needed), records which actions would run instead of running them, writes a JSON
/// report and quits. Checks the keyboard plumbing end to end: focus, arrows, Return variants, ⌘K, Esc.
@MainActor
enum SelfTest {
    struct Step: Encodable { let name: String; let ok: Bool; let detail: String }

    static func run(model: AppModel, output: String) async {
        var steps: [Step] = []
        func check(_ name: String, _ ok: Bool, _ detail: String = "") { steps.append(Step(name: name, ok: ok, detail: detail)) }
        func key(_ code: UInt16, _ chars: String, _ flags: NSEvent.ModifierFlags = []) async {
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: model.panel.windowNumber, context: nil, characters: chars,
                                            charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) {
                    model.panel.send(e)
                }
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        let down = String(UnicodeScalar(NSDownArrowFunctionKey)!), up = String(UnicodeScalar(NSUpArrowFunctionKey)!)

        for _ in 0..<60 where model.status == nil { try? await Task.sleep(nanoseconds: 250_000_000) }
        check("index loaded", model.status != nil, model.statusLine)
        model.recordedActions = []
        model.panel.show()
        try? await Task.sleep(nanoseconds: 500_000_000)
        check("panel visible", model.panel.isVisible)
        check("empty query shows recent notes", !model.results.isEmpty, "\(model.results.count) rows")

        for ch in "stress relaxation" { await key(0, String(ch)) }
        // Wait for the semantic merge (or a definite "off") rather than a fixed time: a cold Ollama can take seconds.
        for _ in 0..<60 {
            if case .merged = model.semantic { break }
            if case .off = model.semantic { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        try? await Task.sleep(nanoseconds: 200_000_000)
        check("typing reaches the search field", model.query == "stress relaxation", "query = \(model.query)")
        check("results for the typed query", !model.results.isEmpty, model.results.prefix(3).map(\.title).joined(separator: " | "))

        check("top result selected after semantic re-rank", model.selection.selectedIndex == 0,
              "index \(model.selection.selectedIndex.map(String.init) ?? "nil"), semantic \(model.semantic)")
        let start = model.selection.selectedIndex ?? 0
        await key(125, down); await key(125, down)
        check("↓↓ moves the selection by two", model.selection.selectedIndex == start + 2,
              "from \(start) to \(model.selection.selectedIndex.map(String.init) ?? "nil")")
        await key(126, up)
        check("↑ moves it back one", model.selection.selectedIndex == start + 1)
        let selected = model.selection.selectedID ?? ""
        check("query unchanged by arrows", model.query == "stress relaxation")

        await key(36, "\r", .command)
        await key(36, "\r", [.command, .shift])
        await key(36, "\r")
        let wanted = ["paste-file \(selected)", "paste-passage \(selected)", "open \(selected)"]
        check("⌘↵, ⌘⇧↵, ↵ run paste-file, paste-passage, open", model.recordedActions == wanted,
              "got \(model.recordedActions ?? [])")

        model.recordedActions = []
        await key(40, "k", .command)
        check("⌘K opens the action menu", model.showActionMenu)
        await key(53, "\u{1b}")
        check("Esc closes the action menu, panel stays", !model.showActionMenu && model.panel.isVisible)
        await key(37, "l", .command)
        check("⌘L copies the wikilink", model.recordedActions == ["copy-wikilink \(selected)"], "got \(model.recordedActions ?? [])")
        await key(19, "2", .command)
        check("⌘2 switches scope to Papers", model.scope == .papers)
        await key(18, "1", .command)
        check("⌘1 back to All", model.scope == .all)
        await key(53, "\u{1b}")
        check("Esc hides the panel", !model.panel.isVisible)

        let report = ["passed": steps.allSatisfy(\.ok) ? "yes" : "no"]
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        struct Out: Encodable { let summary: [String: String]; let steps: [Step] }
        try? enc.encode(Out(summary: report, steps: steps)).write(to: URL(fileURLWithPath: output))
        NSApplication.shared.terminate(nil)
    }
}
