import AppKit
import SemanteroKit
import Quartz
import SwiftUI

/// A borderless floating panel that takes keyboard input without activating the app, so the app you were in stays
/// frontmost and ⌘V reaches it.
final class SearchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class PanelController: NSObject, PanelControl, NSWindowDelegate {
    static let width: CGFloat = 760
    static let cornerRadius: CGFloat = 22
    private let model: AppModel
    private let panel: SearchPanel
    private var clickMonitor: Any?

    init(model: AppModel) {
        self.model = model
        panel = SearchPanel(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 400),
                            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView], backing: .buffered, defer: true)
        super.init()
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        let host = NSHostingView(rootView: SearchView(model: model))
        host.sizingOptions = [.preferredContentSize]
        // The window server draws a borderless window's shadow from its pixels. Clip them to the glass's rounded shape so
        // nothing square is left at the corners for the shadow to trace.
        host.wantsLayer = true
        host.layer?.cornerRadius = Self.cornerRadius
        host.layer?.cornerCurve = .continuous
        host.layer?.masksToBounds = true
        panel.contentView = host
    }

    var isVisible: Bool { panel.isVisible }
    var frame: NSRect { panel.frame }

    func toggle() { isVisible ? hide() : show() }

    /// Debugging aid (SEMANTERO_SNAPSHOT): the panel's own view hierarchy as a PNG, drawn by the view itself, so it needs no
    /// screen-recording permission. Glass materials depend on the window server and may come out flat.
    func snapshot(to path: String) {
        guard let view = panel.contentView else { return }
        // Bring the SwiftUI hierarchy up to date with the model first (a state change such as opening the ⌘K menu is
        // otherwise drawn on the next pass of the run loop).
        view.layoutSubtreeIfNeeded()
        view.displayIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        if let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: path)) }
    }

    func show() {
        model.panelWillShow()
        position()
        panel.makeKeyAndOrderFront(nil)
        // The shadow is cached from the last time the panel was on screen, maybe at another height; rebuild it once
        // this frame's content is drawn (on the main actor's next turn, after this one has laid it out).
        Task { [weak self] in self?.panel.invalidateShadow() }
        // The monitor's handler is not main-actor code (AppKit calls it on the main thread, but Swift can't know that).
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isVisible, !self.panel.frame.contains(NSEvent.mouseLocation) else { return }
                self.hide()
            }
        }
    }

    func hide() {
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor); self.clickMonitor = nil }
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        model.panelDidHide()
    }

    /// Centred horizontally, 22% from the top, on the screen with the mouse.
    private func position() {
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
        let size = panel.frame.size
        let x = screen.visibleFrame.midX - size.width / 2
        let top = screen.visibleFrame.maxY - screen.visibleFrame.height * 0.22
        panel.setFrameTopLeftPoint(NSPoint(x: x, y: top))
    }

    /// The panel grows and shrinks with the results; a shadow kept from the old size shows as a square outline.
    func windowDidResize(_ notification: Notification) { panel.invalidateShadow() }

    /// Hide when focus moves elsewhere, except to Quick Look opened from the panel (⌘Y).
    func windowDidResignKey(_ notification: Notification) {
        // Look one main-actor turn later: Quick Look's panel takes key first and only reports itself visible after that.
        Task { [weak self] in
            guard let self else { return }
            if QLPreviewPanel.sharedPreviewPanelExists(), QLPreviewPanel.shared().isVisible { return }
            self.hide()
        }
    }

    /// Self-test only: deliver a synthetic key event to the panel as if typed.
    func send(_ event: NSEvent) { panel.sendEvent(event) }
    var windowNumber: Int { panel.windowNumber }
}
