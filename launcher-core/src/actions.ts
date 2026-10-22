import shortcuts from "../shortcuts.json" with { type: "json" };

export type ResultKind = "paper" | "note" | "daily" | "litnote";
export type Need = "filePath" | "noteUrl" | "selectUrl";

export interface ActionDef {
  id: string;
  title: string;
  key: string;
  kinds: ResultKind[];
  needs: Need[];
}

export const ACTIONS: ActionDef[] = shortcuts.actions as ActionDef[];
export const RESERVED_KEYS: string[] = shortcuts.reserved;

/** Action ids available for a result, in menu order. */
export function actionsFor(kind: ResultKind, has: { filePath: boolean; noteUrl: boolean; selectUrl: boolean }): string[] {
  return ACTIONS.filter((a) => a.kinds.includes(kind) && a.needs.every((n) => has[n])).map((a) => a.id);
}
