import Foundation

// MARK: Collaborators (each has a real implementation in SystemServices.swift and a fake in the tests)

public struct PasteboardSnapshot: Sendable { public let items: [[String: Data]]; public init(items: [[String: Data]]) { self.items = items } }

public protocol PasteboardService: Sendable {
    func snapshot() -> PasteboardSnapshot
    func restore(_ snapshot: PasteboardSnapshot)
    func writeFile(_ url: URL)
    func writeString(_ text: String)
}
public protocol KeyEventPosting: Sendable { func postCommandV() }
public protocol WorkspaceService: Sendable {
    func open(_ url: URL)
    func reveal(_ url: URL)
}
public protocol SystemState: Sendable {
    var accessibilityTrusted: Bool { get }
    var secureInputEnabled: Bool { get }
}
public protocol FileChecking: Sendable { func exists(_ path: String) -> Bool }
public protocol PanelControl: Sendable { func hide() async }
public struct ToastAction: Sendable, Equatable { public let title: String; public let url: URL
    public init(title: String, url: URL) { self.title = title; self.url = url } }
public protocol Toasting: Sendable { func show(_ message: String, action: ToastAction?) }
public protocol QuickLooking: Sendable { func preview(_ url: URL) }

public struct ActionServices: Sendable {
    public var pasteboard: PasteboardService
    public var events: KeyEventPosting
    public var workspace: WorkspaceService
    public var system: SystemState
    public var files: FileChecking
    public var panel: PanelControl
    public var toast: Toasting
    public var quickLook: QuickLooking
    public var sleeper: Sleeper
    public init(pasteboard: PasteboardService, events: KeyEventPosting, workspace: WorkspaceService, system: SystemState,
                files: FileChecking, panel: PanelControl, toast: Toasting, quickLook: QuickLooking,
                sleeper: Sleeper = SystemSleeper()) {
        self.pasteboard = pasteboard; self.events = events; self.workspace = workspace; self.system = system
        self.files = files; self.panel = panel; self.toast = toast; self.quickLook = quickLook; self.sleeper = sleeper
    }
}

public enum ActionOutcome: Equatable, Sendable {
    case done
    /// The content is on the clipboard but could not be pasted automatically.
    case copiedOnly(String)
    case failed(String)
    case unsupported(String)
}

/// Runs an action id from `shortcuts.json` on a result. The panel never activates, so the app that was frontmost
/// stays frontmost and ⌘V reaches it.
public final class ActionExecutor: Sendable {
    public static let settleMilliseconds = 60
    public static let restoreMilliseconds = 750
    public static let accessibilitySettingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!

    /// Every action id this executor implements (a test checks it covers shortcuts.json).
    public static let supportedIDs: Set<String> = [
        "open", "paste-file", "paste-passage", "copy-file", "copy-passage", "copy-path", "reveal", "quicklook",
        "copy-wikilink", "open-note", "select-zotero",
    ]

    private let services: ActionServices
    private let restoreClipboard: @Sendable () -> Bool

    public init(services: ActionServices, restoreClipboard: @escaping @Sendable () -> Bool = { false }) {
        self.services = services; self.restoreClipboard = restoreClipboard
    }

    public func run(_ id: String, on vm: ResultVM) async -> ActionOutcome {
        switch id {
        case "open": return await openURL(vm.openUrl)
        case "open-note": return await openURL(vm.noteUrl)
        case "select-zotero": return await openURL(vm.selectUrl)
        case "paste-file": return await paste(file: vm)
        case "paste-passage": return await paste(text: vm.citation)
        case "copy-file": return await copy(file: vm)
        case "copy-passage": return await copy(text: vm.citation, label: "passage")
        case "copy-wikilink": return await copy(text: vm.wikilink, label: vm.wikilink)
        case "copy-path":
            guard let path = vm.filePath else { return .failed("No file for this result") }
            return await copy(text: path, label: "path")
        case "reveal":
            guard let url = existingFile(vm) else { return .failed(missingMessage(vm)) }
            services.workspace.reveal(url)
            await services.panel.hide()
            return .done
        case "quicklook":
            guard let url = existingFile(vm) else { return .failed(missingMessage(vm)) }
            services.quickLook.preview(url)
            return .done
        default:
            return .unsupported(id)
        }
    }

    // MARK: pieces

    private func openURL(_ text: String?) async -> ActionOutcome {
        guard let text, let url = URL(string: text) else { return .failed("Nothing to open") }
        services.workspace.open(url)
        await services.panel.hide()
        return .done
    }

    private func existingFile(_ vm: ResultVM) -> URL? {
        guard let path = vm.filePath, services.files.exists(path) else { return nil }
        return URL(fileURLWithPath: path)
    }

    private func missingMessage(_ vm: ResultVM) -> String {
        "File not found: \(vm.filePath.map { ($0 as NSString).lastPathComponent } ?? "no file for this result")"
    }

    private func copy(file vm: ResultVM) async -> ActionOutcome {
        guard let url = existingFile(vm) else { return .failed(missingMessage(vm)) }
        services.pasteboard.writeFile(url)
        await services.panel.hide()
        services.toast.show("Copied \(url.lastPathComponent)", action: nil)
        return .done
    }

    private func copy(text: String, label: String) async -> ActionOutcome {
        services.pasteboard.writeString(text)
        await services.panel.hide()
        services.toast.show("Copied \(label)", action: nil)
        return .done
    }

    private func paste(file vm: ResultVM) async -> ActionOutcome {
        guard let url = existingFile(vm) else { return .failed(missingMessage(vm)) }
        return await paste { $0.pasteboard.writeFile(url) }
    }

    private func paste(text: String) async -> ActionOutcome {
        await paste { $0.pasteboard.writeString(text) }
    }

    private func paste(write: (ActionServices) -> Void) async -> ActionOutcome {
        let previous = restoreClipboard() ? services.pasteboard.snapshot() : nil
        write(services)
        await services.panel.hide()
        try? await services.sleeper.sleep(seconds: Double(Self.settleMilliseconds) / 1000)
        if !services.system.accessibilityTrusted {
            services.toast.show(
                "Copied, press ⌘V. Allow Daito Search in Privacy & Security → Accessibility to paste automatically.",
                action: ToastAction(title: "Open Settings", url: Self.accessibilitySettingsURL))
            return .copiedOnly("accessibility permission missing")
        }
        if services.system.secureInputEnabled {
            services.toast.show("Copied, paste manually.", action: nil)
            return .copiedOnly("secure input is on")
        }
        services.events.postCommandV()
        if let previous {
            try? await services.sleeper.sleep(seconds: Double(Self.restoreMilliseconds) / 1000)
            services.pasteboard.restore(previous)
        }
        return .done
    }
}
