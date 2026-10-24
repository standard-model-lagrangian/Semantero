import SemanteroKit
import SwiftUI

/// ⌘K: every action available for the selected result, filterable by typing. Drawn as a near-opaque card over a dimmed
/// panel (not glass: glass nested in the panel's glass let the results show through and made it unreadable).
struct ActionMenu: View {
    @Bindable var model: AppModel
    @State private var filter = ""
    @State private var index = 0
    @FocusState private var focused: Bool

    static let width: CGFloat = 330
    static let maxListHeight: CGFloat = 300
    static let rowHeight: CGFloat = 30

    private var items: [ActionDef] {
        guard let vm = model.selection.selected else { return [] }
        let all = vm.actions.compactMap { model.shortcuts.definition(for: $0) }
        return filter.isEmpty ? all : all.filter { $0.title.localizedCaseInsensitiveContains(filter) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let vm = model.selection.selected {
                HStack(spacing: 6) {
                    Image(systemName: symbol(for: vm.kind)).foregroundStyle(.secondary)
                    Text(vm.title).lineLimit(1).truncationMode(.middle).foregroundStyle(.secondary)
                }
                .font(.caption).padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 6)
            }
            TextField("Filter actions…", text: $filter)
                .textFieldStyle(.plain).focused($focused).padding(.horizontal, 12).padding(.bottom, 8)
                .onKeyPress(phases: .down) { press in
                    switch press.key {
                    case .upArrow: index = max(0, index - 1); return .handled
                    case .downArrow: index = min(max(items.count - 1, 0), index + 1); return .handled
                    case .return: run(index); return .handled
                    case .escape: model.showActionMenu = false; return .handled
                    default: return .ignored
                    }
                }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { i, a in
                            row(a, selected: i == index).id(a.id).onTapGesture { run(i) }
                        }
                        if items.isEmpty {
                            Text("No matching action").foregroundStyle(.secondary).frame(height: Self.rowHeight)
                        }
                    }
                    .padding(6)
                }
                .frame(height: min(CGFloat(max(items.count, 1)) * Self.rowHeight + 12, Self.maxListHeight))
                .onChange(of: index) { _, i in if items.indices.contains(i) { proxy.scrollTo(items[i].id) } }
            }
        }
        .frame(width: Self.width)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .windowBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(nsColor: .separatorColor)))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.25), radius: 18, y: 6)
        .onAppear { focused = true }
        .onChange(of: filter) { _, _ in index = 0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Actions")
    }

    private func row(_ a: ActionDef, selected: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: Self.icon(a.id)).frame(width: 18).foregroundStyle(selected ? .primary : .secondary)
            Text(a.title).lineLimit(1)
            Spacer(minLength: 12)
            Text(model.shortcuts.chord(for: a.id)?.glyphs ?? "")
                .font(.caption.monospaced()).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .frame(height: Self.rowHeight)
        .background { if selected { RoundedRectangle(cornerRadius: 7).fill(Color.accentColor.opacity(0.22)) } }
        .contentShape(Rectangle())
    }

    static func icon(_ id: String) -> String {
        switch id {
        case "open": return "arrow.up.forward.app"
        case "paste-file": return "doc.on.clipboard"
        case "paste-passage": return "text.quote"
        case "copy-file": return "doc.on.doc"
        case "copy-passage": return "quote.opening"
        case "copy-path": return "point.topleft.down.to.point.bottomright.curvepath"
        case "reveal": return "folder"
        case "quicklook": return "eye"
        case "paste-wikilink": return "link"
        case "open-note": return "note.text"
        case "select-zotero": return "books.vertical"
        default: return "circle"
        }
    }

    private func run(_ i: Int) {
        guard items.indices.contains(i) else { return }
        model.run(items[i].id)
    }
}
