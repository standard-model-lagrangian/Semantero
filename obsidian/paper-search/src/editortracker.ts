/**
 * Remembers the last active Markdown view, so the related-papers panel can refresh and cite
 * even though clicking in the panel makes the panel the active view.
 *
 * Obsidian's getActiveViewOfType needs the MarkdownView class (it uses instanceof), and only
 * returns the view that is active right now; neither fits a sidebar panel.
 */

export interface EditorLike {
  getValue(): string;
  getSelection(): string;
  getCursor(): any;
  posToOffset(pos: any): number;
  replaceRange?(text: string, from: any, to?: any): void;
}

export interface MarkdownViewLike {
  leaf?: { view?: unknown } | null;
  file?: { path: string } | null;
  editor?: EditorLike;
  getViewType(): string;
}

function isMarkdownView(view: any): view is MarkdownViewLike {
  return !!view && typeof view.getViewType === "function" && view.getViewType() === "markdown" && !!view.editor;
}

export class ActiveEditorTracker {
  private last: MarkdownViewLike | null = null;

  /** Call from workspace "active-leaf-change". */
  onActiveLeafChange(leaf: { view?: unknown } | null | undefined): void {
    const view = leaf?.view;
    if (isMarkdownView(view)) this.last = view;
  }

  /** Call once on layout ready with the currently active Markdown view, if any. */
  seed(view: unknown): void {
    if (isMarkdownView(view)) this.last = view;
  }

  /** The last Markdown view, or null if it has since been closed or its leaf reused. */
  get(): MarkdownViewLike | null {
    const v = this.last;
    if (!v) return null;
    if (v.leaf && v.leaf.view !== v) {
      this.last = null;
      return null;
    }
    return v;
  }
}

export interface EditorSnapshot {
  text: string;
  cursorOffset: number;
  selection: string;
  filePath: string;
}

export function editorSnapshot(view: MarkdownViewLike | null): EditorSnapshot | null {
  const editor = view?.editor;
  if (!editor) return null;
  return {
    text: editor.getValue(),
    cursorOffset: editor.posToOffset(editor.getCursor()),
    selection: editor.getSelection(),
    filePath: view?.file?.path || "",
  };
}
