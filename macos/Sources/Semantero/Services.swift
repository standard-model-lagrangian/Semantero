import AppKit
import SemanteroKit
import Quartz
import SwiftUI

/// A small message near the top of the screen (copy confirmations, "File not found", the Accessibility hint).
@MainActor
final class ToastCenter: Toasting {
    static let shared = ToastCenter()
    private var window: NSPanel?
    private var hideTask: Task<Void, Never>?

    nonisolated func show(_ message: String, action: ToastAction?) {
        Task { @MainActor in self.present(message, action: action) }
    }

    private func present(_ message: String, action: ToastAction?) {
        hideTask?.cancel()
        window?.orderOut(nil)
        let view = ToastView(message: message, action: action) { [weak self] in self?.window?.orderOut(nil) }
        let host = NSHostingView(rootView: view)
        let size = host.fittingSize
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.nonactivatingPanel, .borderless],
                            backing: .buffered, defer: true)
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.contentView = host
        let screen = NSScreen.main ?? NSScreen.screens[0]
        panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.midX - size.width / 2, y: screen.visibleFrame.maxY - 16))
        panel.orderFrontRegardless()
        window = panel
        hideTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: action == nil ? 2_500_000_000 : 8_000_000_000)
            if !Task.isCancelled { panel.orderOut(nil) }
        }
    }
}

struct ToastView: View {
    let message: String
    let action: ToastAction?
    let dismiss: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            Text(message).frame(maxWidth: 420, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action.title) { NSWorkspace.shared.open(action.url); dismiss() }.buttonStyle(.borderedProminent)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
    }
}

/// Quick Look for the selected file: a standard QLPreviewPanel over the search panel.
@MainActor
final class QuickLookService: NSObject, QuickLooking, @preconcurrency QLPreviewPanelDataSource {
    static let shared = QuickLookService()
    private var url: URL?

    nonisolated func preview(_ url: URL) {
        Task { @MainActor in
            self.url = url
            guard let panel = QLPreviewPanel.shared() else { return }
            panel.dataSource = self
            panel.reloadData()
            panel.level = .floating + 1
            panel.makeKeyAndOrderFront(nil)
        }
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { url == nil ? 0 : 1 }
    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! { url as NSURL? }
}
