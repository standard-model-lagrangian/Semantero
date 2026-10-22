/** Small helpers with no Node or DOM dependencies: this file is bundled for JavaScriptCore. */

/** Realm-safe: `instanceof ArrayBuffer` fails for buffers made in another JS context. */
export function isArrayBuffer(x: unknown): x is ArrayBuffer {
  return Object.prototype.toString.call(x) === "[object ArrayBuffer]";
}

export function toBytes(x: ArrayBuffer | ArrayBufferView): Uint8Array {
  return isArrayBuffer(x) ? new Uint8Array(x) : new Uint8Array((x as ArrayBufferView).buffer, (x as ArrayBufferView).byteOffset, (x as ArrayBufferView).byteLength);
}

/** Float32 view of raw bytes; copies when the view would be misaligned. */
export function toFloat32(x: ArrayBuffer | ArrayBufferView): Float32Array {
  if (isArrayBuffer(x)) return new Float32Array(x);
  const v = x as ArrayBufferView;
  if (v.byteOffset % 4 === 0) return new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
  return new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/** UTF-8 → string. JavaScriptCore's bare JSContext has no TextDecoder. Invalid bytes become U+FFFD. */
export function decodeUtf8(input: ArrayBuffer | ArrayBufferView): string {
  const b = toBytes(input);
  let i = 0;
  const n = b.length;
  if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  const CH = 8192;
  const units = new Uint16Array(CH + 2);
  let u = 0;
  let out = "";
  const flush = () => {
    out += String.fromCharCode.apply(null, units.subarray(0, u) as unknown as number[]);
    u = 0;
  };
  while (i < n) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) {
      cp = c;
    } else if (c >= 0xc2 && c < 0xe0 && i < n && (b[i] & 0xc0) === 0x80) {
      cp = ((c & 0x1f) << 6) | (b[i++] & 0x3f);
    } else if (c >= 0xe0 && c < 0xf0 && i + 1 < n && (b[i] & 0xc0) === 0x80 && (b[i + 1] & 0xc0) === 0x80) {
      cp = ((c & 0x0f) << 12) | ((b[i] & 0x3f) << 6) | (b[i + 1] & 0x3f);
      i += 2;
      if (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000)) cp = 0xfffd;
    } else if (c >= 0xf0 && c < 0xf5 && i + 2 < n && (b[i] & 0xc0) === 0x80 && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) {
      cp = ((c & 0x07) << 18) | ((b[i] & 0x3f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      i += 3;
      if (cp < 0x10000 || cp > 0x10ffff) cp = 0xfffd;
    } else {
      cp = 0xfffd;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      units[u++] = 0xd800 + (cp >> 10);
      units[u++] = 0xdc00 + (cp & 0x3ff);
    } else {
      units[u++] = cp;
    }
    if (u >= CH) flush();
  }
  flush();
  return out;
}

/** Where `load` spends its time (ms), for diagnostics: reported in the status. */
export const loadTimings = { decode: 0, parse: 0, build: 0 };

/** A JSON part that may arrive as a string or as UTF-8 bytes. */
export function parseJsonPart<T>(part: string | ArrayBuffer | ArrayBufferView): T {
  let t = Date.now();
  const text = typeof part === "string" ? part : decodeUtf8(part);
  loadTimings.decode += Date.now() - t;
  t = Date.now();
  const value = JSON.parse(text) as T;
  loadTimings.parse += Date.now() - t;
  return value;
}

/** "Folder/Note name.md" → "Note name" */
export function noteName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Oct", in the machine's time zone. */
export function shortDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "2026-10-20", in the machine's time zone. */
export function isoDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (x: number) => (x < 10 ? `0${x}` : `${x}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
