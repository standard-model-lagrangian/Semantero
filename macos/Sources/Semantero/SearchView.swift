import SemanteroKit
import SwiftUI

extension KeyChord {
    /// "⌘⇧↵"-style glyphs for footers and the action menu.
    var glyphs: String {
        var s = ""
        if control { s += "⌃" }
        if option { s += "⌥" }
        if shift { s += "⇧" }
        if command { s += "⌘" }
        switch key {
        case "return": s += "↵"
        case "escape": s += "⎋"
        case "space": s += "␣"
        default: s += key.uppercased()
        }
        return s
    }
    init(press: KeyPress) {
        let name: String
        switch press.key {
        case .return: name = "return"
        case .escape: name = "escape"
        case .space: name = "space"
        case .tab: name = "tab"
        case .upArrow: name = "up"
        case .downArrow: name = "down"
        default: name = String(press.key.character).lowercased()
        }
        self.init(key: name, command: press.modifiers.contains(.command), shift: press.modifiers.contains(.shift),
                  option: press.modifiers.contains(.option), control: press.modifiers.contains(.control))
    }
}

/// The SF Symbol for a result kind, in the panel and in the Spotlight action's results.
func symbol(for kind: String) -> String {
    switch kind {
    case "paper": return "doc.text"
    case "daily": return "calendar"
    case "litnote": return "note.text.badge.plus"
    default: return "note.text"
    }
}

/// The snippet with its matched words in bold. Ranges are UTF-16 offsets from the ranker.
func attributedSnippet(_ vm: ResultVM) -> AttributedString {
    var out = AttributedString(vm.snippet)
    let units = vm.snippet.utf16
    for pair in vm.snippetBold where pair.count == 2 {
        guard pair[0] >= 0, pair[1] <= units.count, pair[0] < pair[1] else { continue }
        let s = String.Index(utf16Offset: pair[0], in: vm.snippet), e = String.Index(utf16Offset: pair[1], in: vm.snippet)
        if let a = AttributedString.Index(s, within: out), let b = AttributedString.Index(e, within: out) {
            out[a..<b].font = .body.bold()
        }
    }
    return out
}

struct SearchView: View {
    @Bindable var model: AppModel
    @FocusState private var fieldFocused: Bool

    private var rowHeight: CGFloat { 54 }
    private var listHeight: CGFloat { min(CGFloat(max(model.results.count, 1)) * rowHeight, 360) }

    var body: some View {
        GlassEffectContainer {
            VStack(spacing: 0) {
                header
                if !model.results.isEmpty || model.query.isEmpty == false || model.loadMessage != nil {
                    Divider().opacity(0.4)
                    // The ⌘K menu needs room: grow the list area while it is open.
                    content.frame(height: model.showActionMenu ? max(listHeight, ActionMenu.maxListHeight + 80) : listHeight)
                    Divider().opacity(0.4)
                    footer
                }
            }
            .frame(width: PanelController.width)
            .glassEffect(.regular, in: .rect(cornerRadius: PanelController.cornerRadius))
        }
        // Outside the glass container, so the menu is not turned into glass itself.
        .overlay {
            if model.showActionMenu {
                RoundedRectangle(cornerRadius: PanelController.cornerRadius).fill(.black.opacity(0.22))
                    .onTapGesture { model.showActionMenu = false }
                    .accessibilityHidden(true)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if model.showActionMenu { ActionMenu(model: model).padding(.trailing, 14).padding(.bottom, 40) }
        }
        .onAppear { fieldFocused = true }
        .onChange(of: model.showActionMenu) { _, open in if !open { fieldFocused = true } }
        .onExitCommand { if model.showActionMenu { model.showActionMenu = false } else { Task { await model.panel.hide() } } }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).font(.title3)
            TextField("Search papers and notes", text: $model.query)
                .textFieldStyle(.plain)
                .font(.title2)
                .focused($fieldFocused)
                // On the field itself: the field would otherwise take Return (with any modifier) as submit, and ↑/↓
                // as caret moves, before an ancestor's handler saw them.
                .onKeyPress(phases: .down) { handle($0) }
            Picker("Scope", selection: $model.scope) {
                Text("All").tag(Scope.all); Text("Papers").tag(Scope.papers); Text("Notes").tag(Scope.notes)
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 190)
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
    }

    @ViewBuilder private var content: some View {
        if model.results.isEmpty {
            Text(model.loadMessage ?? (model.query.isEmpty ? "No notes yet" : "No results"))
                .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            HStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            ForEach(model.results) { vm in
                                ResultRow(vm: vm, selected: vm.id == model.selection.selectedID)
                                    .id(vm.id)
                                    .onTapGesture(count: 2) { model.select(id: vm.id); model.run("open", on: vm) }
                                    .onTapGesture { model.select(id: vm.id) }
                                    .modifier(FileDrag(path: vm.filePath))
                            }
                        }.padding(8)
                    }
                    .onChange(of: model.selection.selectedID) { _, id in if let id { proxy.scrollTo(id) } }
                }
                if model.showDetail, let vm = model.selection.selected {
                    Divider().opacity(0.4)
                    DetailPane(vm: vm).frame(width: 280)
                }
            }
        }
    }

    private var footer: some View {
        let vm = model.selection.selected
        return HStack(spacing: 14) {
            if let vm {
                hint("↵", vm.openLabel)
                if vm.actions.contains("paste-file") { hint("⌘↵", "Paste file") }
                if vm.actions.contains("paste-passage") { hint("⌘⇧↵", "Paste passage") }
                hint("⌘K", "Actions")
            } else {
                Text(model.statusLine).foregroundStyle(.secondary)
            }
            Spacer()
            SemanticDot(state: model.semantic)
        }
        .font(.caption).padding(.horizontal, 16).padding(.vertical, 8)
    }

    private func hint(_ keys: String, _ label: String) -> some View {
        HStack(spacing: 4) { Text(keys).foregroundStyle(.secondary).monospaced(); Text(label) }
    }

    private func handle(_ press: KeyPress) -> KeyPress.Result {
        let chord = KeyChord(press: press)
        switch (chord.key, chord.command, chord.shift, chord.option, chord.control) {
        case ("up", false, _, _, _), ("p", false, _, _, true): model.moveSelection(-1); return .handled
        case ("down", false, _, _, _), ("n", false, _, _, true): model.moveSelection(1); return .handled
        case ("k", true, false, false, false): model.showActionMenu.toggle(); return .handled
        case ("return", false, false, false, false): model.run("open"); return .handled
        case ("d", true, false, false, false): model.showDetail.toggle(); return .handled
        case ("1", true, false, false, false): model.scope = .all; return .handled
        case ("2", true, false, false, false): model.scope = .papers; return .handled
        case ("3", true, false, false, false): model.scope = .notes; return .handled
        default: return model.runChord(chord) ? .handled : .ignored
        }
    }
}

/// Rows with a file can be dragged out as that file; rows without one are not draggable.
struct FileDrag: ViewModifier {
    let path: String?
    func body(content: Content) -> some View {
        if let path { content.draggable(URL(fileURLWithPath: path)) } else { content }
    }
}

struct ResultRow: View {
    let vm: ResultVM
    let selected: Bool
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol(for: vm.kind)).frame(width: 22).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(vm.title).lineLimit(1).fontWeight(.medium)
                    if vm.hasNote { Image(systemName: "note.text").font(.caption).foregroundStyle(.secondary) }
                }
                if !vm.subtitle.isEmpty { Text(vm.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 8)
            Text(vm.accessory).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background { if selected { RoundedRectangle(cornerRadius: 10).fill(.tint.opacity(0.22)) } }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(vm.kind == "paper" ? "Paper" : "Note"), \(vm.title), \(vm.subtitle), \(vm.accessory)")
    }
}

struct DetailPane: View {
    let vm: ResultVM
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(vm.title).font(.headline)
                Text(attributedSnippet(vm)).font(.body)
                Divider().opacity(0.4)
                ForEach(Array(vm.detail.enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.label).font(.caption2).foregroundStyle(.secondary)
                        Text(row.value).font(.caption).textSelection(.enabled)
                    }
                }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct SemanticDot: View {
    let state: SemanticState
    var body: some View {
        let (on, text): (Bool, String) = {
            switch state {
            case .merged: return (true, "semantic")
            case .pending: return (true, "semantic…")
            case .notRun: return (true, "semantic")
            case .off(let why): return (false, why.isEmpty ? "semantic off" : "semantic off: \(why)")
            }
        }()
        HStack(spacing: 4) {
            Circle().fill(on ? Color.green : Color.secondary).frame(width: 7, height: 7)
            Text(text).foregroundStyle(.secondary)
        }.help(text)
    }
}
