/**
 * In-memory test fakes for Obsidian and browser/Node environments:
 * - VaultLike & MetadataCacheLike
 * - EditorLike
 * - FakeClock
 * - FakeRequestUrl
 */

export interface FakeFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  content: string;
  stat?: { mtime: number; ctime: number; size: number };
}

export interface FakeSection {
  type: string; // "paragraph" | "heading" | "code" | "math" | "yaml" etc.
  position: {
    start: { line: number; col: number; offset: number };
    end: { line: number; col: number; offset: number };
  };
}

export interface FakeFileCache {
  frontmatter?: Record<string, any>;
  sections?: FakeSection[];
  headings?: { heading: string; level: number; position: any }[];
}

export class FakeVault {
  files: Map<string, FakeFile> = new Map();
  folders: Set<string> = new Set();
  caches: Map<string, FakeFileCache> = new Map();
  throwOnCreate: Error | null = null;

  constructor() {
    this.folders.add("");
  }

  getFiles(): FakeFile[] {
    return Array.from(this.files.values());
  }

  getAbstractFileByPath(path: string): FakeFile | null {
    const normalized = path.replace(/^\/+/, "");
    return this.files.get(normalized) || null;
  }

  getFileByPath(path: string): FakeFile | null {
    return this.getAbstractFileByPath(path);
  }

  async read(file: FakeFile): Promise<string> {
    return file.content;
  }

  async modify(file: FakeFile, content: string): Promise<void> {
    file.content = content;
  }

  async create(filePath: string, content: string): Promise<FakeFile> {
    if (this.throwOnCreate) {
      const err = this.throwOnCreate;
      this.throwOnCreate = null;
      throw err;
    }
    const normalized = filePath.replace(/^\/+/, "");
    if (this.files.has(normalized)) {
      throw new Error(`File already exists: ${normalized}`);
    }
    const parts = normalized.split("/");
    const name = parts[parts.length - 1];
    const dotIdx = name.lastIndexOf(".");
    const basename = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
    const extension = dotIdx >= 0 ? name.slice(dotIdx + 1) : "";

    const file: FakeFile = {
      path: normalized,
      name,
      basename,
      extension,
      content,
      stat: { mtime: Date.now(), ctime: Date.now(), size: content.length },
    };
    this.files.set(normalized, file);
    return file;
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalized = folderPath.replace(/^\/+|\/+$/g, "");
    this.folders.add(normalized);
  }

  // Helper for tests to populate a file + cache
  addFile(filePath: string, content: string, cache?: FakeFileCache): FakeFile {
    const normalized = filePath.replace(/^\/+/, "");
    const parts = normalized.split("/");
    const name = parts[parts.length - 1];
    const dotIdx = name.lastIndexOf(".");
    const basename = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
    const extension = dotIdx >= 0 ? name.slice(dotIdx + 1) : "";

    const file: FakeFile = {
      path: normalized,
      name,
      basename,
      extension,
      content,
      stat: { mtime: Date.now(), ctime: Date.now(), size: content.length },
    };
    this.files.set(normalized, file);
    if (cache) {
      this.caches.set(normalized, cache);
    }
    return file;
  }
}

export class FakeMetadataCache {
  vault: FakeVault;

  constructor(vault: FakeVault) {
    this.vault = vault;
  }

  getFileCache(file: FakeFile): FakeFileCache | null {
    return this.vault.caches.get(file.path) || null;
  }
}

export interface EditorPosition {
  line: number;
  ch: number;
}

export interface ReplaceRangeCall {
  replacement: string;
  from: EditorPosition;
  to: EditorPosition;
}

export class FakeEditor {
  lines: string[];
  cursor: EditorPosition;
  replaceRangeCalls: ReplaceRangeCall[] = [];
  selection: { from: EditorPosition; to: EditorPosition } | null = null;

  constructor(content: string = "", cursor: EditorPosition = { line: 0, ch: 0 }) {
    this.lines = content.split("\n");
    this.cursor = cursor;
  }

  getCursor(): EditorPosition {
    return { ...this.cursor };
  }

  setCursor(pos: EditorPosition): void {
    this.cursor = { ...pos };
  }

  getLine(line: number): string {
    return this.lines[line] ?? "";
  }

  lineCount(): number {
    return this.lines.length;
  }

  getValue(): string {
    return this.lines.join("\n");
  }

  setValue(val: string): void {
    this.lines = val.split("\n");
  }

  getSelection(): string {
    if (!this.selection) return "";
    const { from, to } = this.selection;
    if (from.line === to.line) {
      return this.lines[from.line].slice(from.ch, to.ch);
    }
    const parts: string[] = [];
    parts.push(this.lines[from.line].slice(from.ch));
    for (let l = from.line + 1; l < to.line; l++) {
      parts.push(this.lines[l]);
    }
    parts.push(this.lines[to.line].slice(0, to.ch));
    return parts.join("\n");
  }

  setSelection(from: EditorPosition, to: EditorPosition): void {
    this.selection = { from: { ...from }, to: { ...to } };
  }

  replaceRange(replacement: string, from: EditorPosition, to: EditorPosition = from): void {
    this.replaceRangeCalls.push({ replacement, from: { ...from }, to: { ...to } });

    const before = this.lines[from.line].slice(0, from.ch);
    const after = this.lines[to.line].slice(to.ch);
    const middle = replacement.split("\n");

    if (middle.length === 1) {
      this.lines[from.line] = before + middle[0] + after;
      if (to.line > from.line) {
        this.lines.splice(from.line + 1, to.line - from.line);
      }
      this.cursor = { line: from.line, ch: before.length + middle[0].length };
    } else {
      const newLines: string[] = [];
      newLines.push(before + middle[0]);
      for (let i = 1; i < middle.length - 1; i++) {
        newLines.push(middle[i]);
      }
      newLines.push(middle[middle.length - 1] + after);
      this.lines.splice(from.line, to.line - from.line + 1, ...newLines);
      this.cursor = {
        line: from.line + middle.length - 1,
        ch: middle[middle.length - 1].length,
      };
    }
  }

  offsetToPos(offset: number): EditorPosition {
    let current = 0;
    for (let l = 0; l < this.lines.length; l++) {
      const lineLen = this.lines[l].length;
      if (offset <= current + lineLen) {
        return { line: l, ch: offset - current };
      }
      current += lineLen + 1; // +1 for newline
    }
    return { line: this.lines.length - 1, ch: this.lines[this.lines.length - 1].length };
  }

  posToOffset(pos: EditorPosition): number {
    let offset = 0;
    for (let l = 0; l < pos.line && l < this.lines.length; l++) {
      offset += this.lines[l].length + 1;
    }
    offset += pos.ch;
    return offset;
  }
}

export class FakeClock {
  currentTime: number;
  private timers: { id: number; due: number; fn: () => void }[] = [];
  private nextId = 1;

  constructor(initialTime = 1000) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout(fn: () => void, ms: number): any {
    const id = this.nextId++;
    this.timers.push({ id, due: this.currentTime + ms, fn });
    this.timers.sort((a, b) => a.due - b.due);
    return id;
  }

  clearTimeout(id: any): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  advance(ms: number): void {
    const target = this.currentTime + ms;
    while (this.timers.length > 0 && this.timers[0].due <= target) {
      const timer = this.timers.shift()!;
      this.currentTime = timer.due;
      timer.fn();
    }
    this.currentTime = target;
  }

  runAll(): void {
    while (this.timers.length > 0) {
      const timer = this.timers.shift()!;
      this.currentTime = timer.due;
      timer.fn();
    }
  }
}

export class FakeRequestUrl {
  callCount = 0;
  calls: any[] = [];
  shouldFail = false;
  failureError = new Error("Connection refused (Ollama offline)");
  dims = 1024;

  handler: ((req: any) => Promise<any>) | null = null;

  async requestUrl(req: any): Promise<any> {
    this.callCount++;
    this.calls.push(req);
    if (this.shouldFail) {
      throw this.failureError;
    }
    if (this.handler) {
      return this.handler(req);
    }
    // Default mock response for Ollama embedding request
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const input = body?.input ?? "";
    const dims = this.dims;
    let embeddings: number[][];

    if (Array.isArray(input)) {
      embeddings = input.map((text: string) => {
        const vec = new Array(dims).fill(0);
        let hash = 0;
        for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
        vec[Math.abs(hash) % dims] = 1.0;
        return vec;
      });
    } else {
      const vec = new Array(dims).fill(0);
      let hash = 0;
      const text = String(input);
      for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
      vec[Math.abs(hash) % dims] = 1.0;
      embeddings = [vec];
    }

    return {
      status: 200,
      json: { embeddings },
      text: JSON.stringify({ embeddings }),
    };
  }
}
