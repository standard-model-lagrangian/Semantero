import type { ChunkDocument } from "./bm25.ts";

/**
 * Many strings packed as WTF-8 (UTF-8 that also round-trips unpaired surrogates) in one byte array, decoded on demand.
 * Chunk texts are needed in full only to build the keyword index; afterwards only for the dozen results on screen. As
 * JavaScript strings they cost ~30 MB in JavaScriptCore (most chunks hold some non-Latin-1 character, which makes the
 * whole string 2 bytes per character); packed, ~15 MB in a single allocation outside the GC heap.
 */
export class TextStore {
  private readonly bytes: Uint8Array;
  private readonly offsets: Int32Array;

  private constructor(bytes: Uint8Array, offsets: Int32Array) {
    this.bytes = bytes;
    this.offsets = offsets;
  }

  get count(): number {
    return this.offsets.length - 1;
  }

  get byteLength(): number {
    return this.bytes.length;
  }

  static from(texts: readonly string[]): TextStore {
    const offsets = new Int32Array(texts.length + 1);
    let total = 0;
    for (let i = 0; i < texts.length; i++) {
      total += encodedLength(texts[i]);
      offsets[i + 1] = total;
    }
    const bytes = new Uint8Array(total);
    for (let i = 0; i < texts.length; i++) encodeInto(texts[i], bytes, offsets[i]);
    return new TextStore(bytes, offsets);
  }

  get(i: number): string {
    if (i < 0 || i >= this.count) return "";
    return decode(this.bytes, this.offsets[i], this.offsets[i + 1]);
  }
}

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;

function encodedLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u < 0x80) n += 1;
    else if (u < 0x800) n += 2;
    else if (isHigh(u) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) { n += 4; i++; }
    else n += 3; // BMP, or an unpaired surrogate (WTF-8)
  }
  return n;
}

function encodeInto(s: string, out: Uint8Array, at: number): void {
  for (let i = 0; i < s.length; i++) {
    let u = s.charCodeAt(i);
    if (u < 0x80) {
      out[at++] = u;
    } else if (u < 0x800) {
      out[at++] = 0xc0 | (u >> 6);
      out[at++] = 0x80 | (u & 0x3f);
    } else if (isHigh(u) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      u = 0x10000 + ((u - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      out[at++] = 0xf0 | (u >> 18);
      out[at++] = 0x80 | ((u >> 12) & 0x3f);
      out[at++] = 0x80 | ((u >> 6) & 0x3f);
      out[at++] = 0x80 | (u & 0x3f);
    } else {
      out[at++] = 0xe0 | (u >> 12);
      out[at++] = 0x80 | ((u >> 6) & 0x3f);
      out[at++] = 0x80 | (u & 0x3f);
    }
  }
}

function decode(b: Uint8Array, start: number, end: number): string {
  const units: number[] = [];
  let out = "";
  for (let i = start; i < end; ) {
    const c = b[i];
    if (c < 0x80) { units.push(c); i += 1; }
    else if (c < 0xe0) { units.push(((c & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
    else if (c < 0xf0) { units.push(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; }
    else {
      const cp = (((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f)) - 0x10000;
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      i += 4;
    }
    if (units.length >= 8192) { out += String.fromCharCode.apply(null, units); units.length = 0; }
  }
  return out + String.fromCharCode.apply(null, units);
}

/**
 * After the keyword index is built, chunk texts move into one packed byte array (see TextStore) and each chunk reads
 * its text through a getter, so the engine's snippet code is unchanged. Repeated attachment keys and headings share one
 * string. Replaces the array's elements in place: the keyword index holds the same array.
 */
export function compactChunkTexts(chunks: (ChunkDocument & { row?: number })[]): TextStore {
  const store = TextStore.from(chunks.map((c) => c.text));
  const proto = Object.defineProperty({}, "text", {
    get(this: { i: number }) {
      return store.get(this.i);
    },
    enumerable: true,
  });
  const shared = new Map<string, string>();
  const intern = (v: string | undefined) => {
    if (v === undefined) return v;
    let s = shared.get(v);
    if (s === undefined) { s = v; shared.set(v, v); }
    return s;
  };
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const lean = Object.create(proto) as ChunkDocument & { row?: number; i: number };
    lean.i = i;
    lean.paper = c.paper;
    lean.attachmentKey = intern(c.attachmentKey)!;
    lean.page = c.page;
    lean.row = c.row;
    if (c.heading !== undefined) lean.heading = intern(c.heading);
    if (c.line !== undefined) lean.line = c.line;
    chunks[i] = lean;
  }
  return store;
}
