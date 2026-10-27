import Carbon.HIToolbox
import Foundation

/// A global hotkey written like "⌥Space" or "⌃⌥⌘K": Carbon key code and modifier mask.
public struct HotkeySpec: Equatable, Sendable, CustomStringConvertible {
    public let keyCode: UInt32
    public let modifiers: UInt32
    public let keyName: String

    public enum ParseError: Error, Equatable { case noKey, noModifier, unknownKey(String) }

    private static let modifierSymbols: [(String, UInt32)] = [
        ("⌃", UInt32(controlKey)), ("⌥", UInt32(optionKey)), ("⇧", UInt32(shiftKey)), ("⌘", UInt32(cmdKey)),
    ]
    private static let modifierWords: [String: UInt32] = [
        "ctrl": UInt32(controlKey), "control": UInt32(controlKey), "opt": UInt32(optionKey), "option": UInt32(optionKey),
        "alt": UInt32(optionKey), "shift": UInt32(shiftKey), "cmd": UInt32(cmdKey), "command": UInt32(cmdKey),
    ]
    private static let keys: [String: Int] = {
        var m: [String: Int] = [
            "space": kVK_Space, "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "escape": kVK_Escape,
            "delete": kVK_Delete, "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
            "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash,
            ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
            "\\": kVK_ANSI_Backslash, "`": kVK_ANSI_Grave,
        ]
        let letters: [(String, Int)] = [("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D), ("e", kVK_ANSI_E),
            ("f", kVK_ANSI_F), ("g", kVK_ANSI_G), ("h", kVK_ANSI_H), ("i", kVK_ANSI_I), ("j", kVK_ANSI_J), ("k", kVK_ANSI_K),
            ("l", kVK_ANSI_L), ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O), ("p", kVK_ANSI_P), ("q", kVK_ANSI_Q),
            ("r", kVK_ANSI_R), ("s", kVK_ANSI_S), ("t", kVK_ANSI_T), ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W),
            ("x", kVK_ANSI_X), ("y", kVK_ANSI_Y), ("z", kVK_ANSI_Z)]
        for (k, v) in letters { m[k] = v }
        let digits: [(String, Int)] = [("0", kVK_ANSI_0), ("1", kVK_ANSI_1), ("2", kVK_ANSI_2), ("3", kVK_ANSI_3), ("4", kVK_ANSI_4),
            ("5", kVK_ANSI_5), ("6", kVK_ANSI_6), ("7", kVK_ANSI_7), ("8", kVK_ANSI_8), ("9", kVK_ANSI_9)]
        for (k, v) in digits { m[k] = v }
        let fn: [Int] = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12]
        for (i, v) in fn.enumerated() { m["f\(i + 1)"] = v }
        return m
    }()

    public init(keyCode: UInt32, modifiers: UInt32, keyName: String) {
        self.keyCode = keyCode; self.modifiers = modifiers; self.keyName = keyName
    }

    /// "⌥Space", "⌃⌥⌘K", "cmd+shift+f". A modifier is required (a bare key would hijack typing everywhere).
    public init(parsing text: String) throws {
        var mods: UInt32 = 0
        var rest = text.trimmingCharacters(in: .whitespaces)
        for (sym, mask) in Self.modifierSymbols where rest.contains(sym) {
            mods |= mask
            rest = rest.replacingOccurrences(of: sym, with: "")
        }
        var keyName = ""
        for part in rest.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) where !part.isEmpty {
            if let m = Self.modifierWords[part] { mods |= m } else { keyName = part }
        }
        if keyName.isEmpty, let last = rest.trimmingCharacters(in: .whitespaces).lowercased().split(separator: " ").last, !rest.contains("+") {
            keyName = String(last)
        }
        guard !keyName.isEmpty else { throw ParseError.noKey }
        guard let code = Self.keys[keyName] else { throw ParseError.unknownKey(keyName) }
        guard mods != 0 else { throw ParseError.noModifier }
        self.init(keyCode: UInt32(code), modifiers: mods, keyName: keyName)
    }

    public var description: String {
        var s = ""
        for (sym, mask) in Self.modifierSymbols where modifiers & mask != 0 { s += sym }
        return s + (keyName.count == 1 ? keyName.uppercased() : keyName.prefix(1).uppercased() + keyName.dropFirst())
    }
}

/// Registers one global hotkey (Carbon `RegisterEventHotKey`: needs no permission).
public final class HotkeyRegistrar: @unchecked Sendable {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var onPress: (@Sendable () -> Void)?

    public init() {}
    deinit { unregister() }

    @discardableResult
    public func register(_ spec: HotkeySpec, onPress: @escaping @Sendable () -> Void) -> Bool {
        unregister()
        self.onPress = onPress
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            Unmanaged<HotkeyRegistrar>.fromOpaque(userData).takeUnretainedValue().onPress?()
            return noErr
        }, 1, &type, Unmanaged.passUnretained(self).toOpaque(), &handlerRef)
        guard status == noErr else { return false }
        let id = EventHotKeyID(signature: OSType(0x4441_4954), id: 1)  // 'DAIT', from the app's old name; any four-char code will do
        return RegisterEventHotKey(spec.keyCode, spec.modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef) == noErr
    }

    public func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef); self.hotKeyRef = nil }
        if let handlerRef { RemoveEventHandler(handlerRef); self.handlerRef = nil }
    }
}
