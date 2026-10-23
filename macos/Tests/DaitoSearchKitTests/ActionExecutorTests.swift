import Foundation
import Testing
@testable import DaitoSearchKit

/// Fakes for every collaborator; they all write into one ordered log.
private final class Fakes: @unchecked Sendable {
    let log = CallLog()
    var accessibility = true
    var secureInput = false
    var existing: Set<String> = ["/Z/storage/ATT1/a.pdf", "/vault/Note.md"]
    var toasts: [(String, ToastAction?)] = []
    var snapshotToReturn = PasteboardSnapshot(items: [["public.utf8-plain-text": Data("old".utf8)]])

    struct PB: PasteboardService {
        let f: Fakes
        func snapshot() -> PasteboardSnapshot { f.log.add("snapshot"); return f.snapshotToReturn }
        func restore(_ s: PasteboardSnapshot) { f.log.add("restore:\(s.items.count)") }
        func writeFile(_ url: URL) { f.log.add("write-file:\(url.path)") }
        func writeString(_ t: String) { f.log.add("write-string:\(t)") }
    }
    struct Keys: KeyEventPosting { let f: Fakes; func postCommandV() { f.log.add("post-cmd-v") } }
    struct WS: WorkspaceService {
        let f: Fakes
        func open(_ url: URL) { f.log.add("open:\(url.absoluteString)") }
        func reveal(_ url: URL) { f.log.add("reveal:\(url.path)") }
    }
    struct Sys: SystemState { let f: Fakes; var accessibilityTrusted: Bool { f.accessibility }; var secureInputEnabled: Bool { f.secureInput } }
    struct Files: FileChecking { let f: Fakes; func exists(_ p: String) -> Bool { f.existing.contains(p) } }
    struct Panel: PanelControl { let f: Fakes; func hide() async { f.log.add("hide") } }
    struct Toast: Toasting { let f: Fakes; func show(_ m: String, action: ToastAction?) { f.log.add("toast:\(m)"); f.toasts.append((m, action)) } }
    struct QL: QuickLooking { let f: Fakes; func preview(_ url: URL) { f.log.add("quicklook:\(url.path)") } }
    final class RecordingSleeper: Sleeper, @unchecked Sendable {
        let f: Fakes
        init(_ f: Fakes) { self.f = f }
        func sleep(seconds: Double) async throws { f.log.add("sleep:\(Int((seconds * 1000).rounded()))") }
    }

    func executor(restore: Bool = false) -> ActionExecutor {
        ActionExecutor(services: ActionServices(
            pasteboard: PB(f: self), events: Keys(f: self), workspace: WS(f: self), system: Sys(f: self), files: Files(f: self),
            panel: Panel(f: self), toast: Toast(f: self), quickLook: QL(f: self), sleeper: RecordingSleeper(self)),
            restoreClipboard: { restore })
    }
}

private let paper = vm("P:K1", title: "A paper", filePath: "/Z/storage/ATT1/a.pdf",
                       actions: ["open", "paste-file"], openUrl: "zotero://open-pdf/library/items/ATT1?page=6",
                       noteUrl: "obsidian://open?vault=V&file=k1", selectUrl: "zotero://select/library/items/K1",
                       citation: "\"…passage…\" (Roth, 2023, p. 6)", wikilink: "[[roth2023]]")

@Suite("ActionExecutor")
struct ActionExecutorTests {
    // S22
    @Test func pasteFileChecksExistenceWritesHidesSettlesThenPostsCmdV() async {
        let f = Fakes()
        let outcome = await f.executor().run("paste-file", on: paper)
        #expect(outcome == .done)
        #expect(f.log.all == ["write-file:/Z/storage/ATT1/a.pdf", "hide", "sleep:60", "post-cmd-v"])
    }

    // S23
    @Test func pastePassageWritesTheCitationNotTheFile() async {
        let f = Fakes()
        let outcome = await f.executor().run("paste-passage", on: paper)
        #expect(outcome == .done)
        #expect(f.log.all == ["write-string:\"…passage…\" (Roth, 2023, p. 6)", "hide", "sleep:60", "post-cmd-v"])
    }

    @Test func pasteWikilinkPastesTheLinkNotJustCopiesIt() async {
        let f = Fakes()
        let outcome = await f.executor().run("paste-wikilink", on: paper)
        #expect(outcome == .done)
        #expect(f.log.all == ["write-string:[[roth2023]]", "hide", "sleep:60", "post-cmd-v"])
    }

    // S24
    @Test func withoutAccessibilityItCopiesOnlyAndOffersTheSettingsPane() async {
        let f = Fakes()
        f.accessibility = false
        let outcome = await f.executor().run("paste-file", on: paper)
        #expect(outcome == .copiedOnly("accessibility permission missing"))
        #expect(!f.log.all.contains("post-cmd-v"))
        let toast = f.toasts.first
        #expect(toast?.0.contains("press ⌘V") == true)
        #expect(toast?.0.contains("Accessibility") == true)
        #expect(toast?.1?.url == ActionExecutor.accessibilitySettingsURL)
    }

    // S25
    @Test func secureInputCopiesOnlyAndSaysToPasteManually() async {
        let f = Fakes()
        f.secureInput = true
        let outcome = await f.executor().run("paste-passage", on: paper)
        #expect(outcome == .copiedOnly("secure input is on"))
        #expect(!f.log.all.contains("post-cmd-v"))
        #expect(f.toasts.first?.0 == "Copied, paste manually.")
    }

    // S26
    @Test func missingFileIsAnErrorAndLeavesThePasteboardAlone() async {
        let f = Fakes()
        f.existing = []
        for action in ["paste-file", "copy-file", "reveal", "quicklook"] {
            let outcome = await f.executor().run(action, on: paper)
            #expect(outcome == .failed("File not found: a.pdf"), "\(action)")
        }
        #expect(f.log.all.isEmpty)
        let none = vm("P:K2", filePath: nil)
        #expect(await f.executor().run("paste-file", on: none) == .failed("File not found: no file for this result"))
        #expect(await f.executor().run("copy-path", on: none) == .failed("No file for this result"))
    }

    // S27
    @Test func restoreClipboardOnRestoresAfterPasteOffLeavesItAlone() async {
        let on = Fakes()
        #expect(await on.executor(restore: true).run("paste-file", on: paper) == .done)
        #expect(on.log.all == ["snapshot", "write-file:/Z/storage/ATT1/a.pdf", "hide", "sleep:60", "post-cmd-v", "sleep:750", "restore:1"])
        let off = Fakes()
        _ = await off.executor(restore: false).run("paste-file", on: paper)
        #expect(!off.log.all.contains("snapshot") && !off.log.all.contains { $0.hasPrefix("restore") })
        // when pasting is not possible the copy must stay on the clipboard
        let blocked = Fakes()
        blocked.accessibility = false
        _ = await blocked.executor(restore: true).run("paste-file", on: paper)
        #expect(!blocked.log.all.contains { $0.hasPrefix("restore") })
    }

    // S28
    @Test func openRevealSelectAndNoteActionsCallTheWorkspaceWithTheViewModelValues() async {
        let f = Fakes()
        let e = f.executor()
        #expect(await e.run("open", on: paper) == .done)
        #expect(await e.run("open-note", on: paper) == .done)
        #expect(await e.run("select-zotero", on: paper) == .done)
        #expect(await e.run("reveal", on: paper) == .done)
        #expect(f.log.all == [
            "open:zotero://open-pdf/library/items/ATT1?page=6", "hide",
            "open:obsidian://open?vault=V&file=k1", "hide",
            "open:zotero://select/library/items/K1", "hide",
            "reveal:/Z/storage/ATT1/a.pdf", "hide",
        ])
        #expect(await e.run("open-note", on: vm("x")) == .failed("Nothing to open"))
    }

    @Test func copyActionsWriteTheRightThingHideAndToast() async {
        let f = Fakes()
        let e = f.executor()
        #expect(await e.run("copy-file", on: paper) == .done)
        #expect(await e.run("copy-passage", on: paper) == .done)
        #expect(await e.run("copy-path", on: paper) == .done)
        let writes = f.log.all.filter { $0.hasPrefix("write-") }
        #expect(writes == ["write-file:/Z/storage/ATT1/a.pdf", "write-string:\"…passage…\" (Roth, 2023, p. 6)",
                           "write-string:/Z/storage/ATT1/a.pdf"])
        #expect(f.log.all.filter { $0 == "hide" }.count == 3)
        #expect(f.toasts.count == 3)
        #expect(!f.log.all.contains("post-cmd-v"))
    }

    @Test func quickLookKeepsThePanelOpen() async {
        let f = Fakes()
        #expect(await f.executor().run("quicklook", on: paper) == .done)
        #expect(f.log.all == ["quicklook:/Z/storage/ATT1/a.pdf"])
    }

    // S29
    @Test func everyActionInShortcutsJsonHasAnExecutorBranch() throws {
        let table = try ShortcutTable(url: Repo.shortcuts)
        let ids = Set(table.actions.map(\.id))
        #expect(ids.isSubset(of: ActionExecutor.supportedIDs), "missing: \(ids.subtracting(ActionExecutor.supportedIDs))")
        #expect(ActionExecutor.supportedIDs.isSubset(of: ids), "executor has branches not in shortcuts.json")
    }

    @Test func unknownActionIsReportedNotIgnored() async {
        #expect(await Fakes().executor().run("explode", on: paper) == .unsupported("explode"))
    }
}
