import Foundation

public struct ActionDef: Codable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let key: String
    public let kinds: [String]
    public let needs: [String]
}

/// A key equivalent such as "cmd+shift+return", as written in `shortcuts.json`.
public struct KeyChord: Hashable, Sendable, CustomStringConvertible {
    public let key: String
    public let command: Bool
    public let shift: Bool
    public let option: Bool
    public let control: Bool

    public init(key: String, command: Bool = false, shift: Bool = false, option: Bool = false, control: Bool = false) {
        self.key = key.lowercased(); self.command = command; self.shift = shift; self.option = option; self.control = control
    }

    public init?(parsing text: String) {
        var cmd = false, shift = false, opt = false, ctrl = false
        var key: String?
        for part in text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init) {
            switch part {
            case "cmd", "command": cmd = true
            case "shift": shift = true
            case "opt", "option", "alt": opt = true
            case "ctrl", "control": ctrl = true
            case "": key = "+"          // a literal "+" is written "cmd++"
            default: key = part
            }
        }
        guard let key else { return nil }
        self.init(key: key, command: cmd, shift: shift, option: opt, control: ctrl)
    }

    public var description: String {
        var parts: [String] = []
        if control { parts.append("ctrl") }
        if option { parts.append("option") }
        if shift { parts.append("shift") }
        if command { parts.append("cmd") }
        parts.append(key)
        return parts.joined(separator: "+")
    }
}

public struct ShortcutTable: Sendable {
    public let actions: [ActionDef]
    public let reserved: [KeyChord]
    private let byChord: [KeyChord: String]

    public init(data: Data) throws {
        struct File: Decodable { let reserved: [String]; let actions: [ActionDef] }
        let file = try JSONDecoder().decode(File.self, from: data)
        actions = file.actions
        reserved = file.reserved.compactMap(KeyChord.init(parsing:))
        var map: [KeyChord: String] = [:]
        for a in file.actions {
            guard let chord = KeyChord(parsing: a.key) else { continue }
            map[chord] = map[chord] ?? a.id
        }
        byChord = map
    }

    public init(url: URL) throws { try self.init(data: Data(contentsOf: url)) }

    public func actionID(for chord: KeyChord) -> String? { byChord[chord] }
    public func chord(for actionID: String) -> KeyChord? {
        actions.first { $0.id == actionID }.flatMap { KeyChord(parsing: $0.key) }
    }
    public func definition(for actionID: String) -> ActionDef? { actions.first { $0.id == actionID } }
    public var allChords: [KeyChord] { actions.compactMap { KeyChord(parsing: $0.key) } }
}
