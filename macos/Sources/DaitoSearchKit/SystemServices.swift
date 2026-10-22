import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

public struct SystemPasteboard: PasteboardService {
    public init() {}
    public func snapshot() -> PasteboardSnapshot {
        let items = (NSPasteboard.general.pasteboardItems ?? []).map { item -> [String: Data] in
            var d: [String: Data] = [:]
            for t in item.types { if let data = item.data(forType: t) { d[t.rawValue] = data } }
            return d
        }
        return PasteboardSnapshot(items: items)
    }
    public func restore(_ snapshot: PasteboardSnapshot) {
        let pb = NSPasteboard.general
        pb.clearContents()
        let items = snapshot.items.map { dict -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in dict { item.setData(data, forType: NSPasteboard.PasteboardType(type)) }
            return item
        }
        pb.writeObjects(items)
    }
    public func writeFile(_ url: URL) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.writeObjects([url as NSURL])
    }
    public func writeString(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }
}

/// ⌘V to whatever app is frontmost (needs the Accessibility permission).
public struct CGEventPoster: KeyEventPosting {
    public init() {}
    public func postCommandV() {
        let source = CGEventSource(stateID: .combinedSessionState)
        let v = CGKeyCode(kVK_ANSI_V)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: down)
            event?.flags = .maskCommand
            event?.post(tap: .cghidEventTap)
        }
    }
}

public struct SystemWorkspace: WorkspaceService {
    public init() {}
    public func open(_ url: URL) { NSWorkspace.shared.open(url) }
    public func reveal(_ url: URL) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
}

public struct LiveSystemState: SystemState {
    public init() {}
    public var accessibilityTrusted: Bool { AXIsProcessTrusted() }
    public var secureInputEnabled: Bool { IsSecureEventInputEnabled() }
}

public struct DiskFiles: FileChecking {
    public init() {}
    public func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }
}
