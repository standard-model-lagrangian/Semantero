export interface HotkeyBinding {
  modifiers: string[];
  key: string;
}

export function checkHotkeyConflict(
  customHotkeys: Record<string, HotkeyBinding[]>,
  targetModifiers: string[] = ["Mod", "Shift"],
  targetKey: string = "0",
  ourCommandId: string = "daito-paper-search:open-paper-search"
): string | null {
  for (const [cmdId, bindings] of Object.entries(customHotkeys)) {
    if (cmdId === ourCommandId) continue;
    if (!Array.isArray(bindings)) continue;
    for (const b of bindings) {
      if (!b || !b.key || !Array.isArray(b.modifiers)) continue;
      const keyMatches = b.key.toLowerCase() === targetKey.toLowerCase();
      const modsMatch =
        b.modifiers.length === targetModifiers.length &&
        targetModifiers.every((m) => b.modifiers.includes(m));
      if (keyMatches && modsMatch) {
        return cmdId;
      }
    }
  }
  return null;
}
