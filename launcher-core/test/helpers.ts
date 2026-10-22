import crypto from "node:crypto";
import path from "node:path";
import { buildCorpora, type Corpora, type RawCorpus } from "../src/corpora.ts";
import { Engine } from "../src/query.ts";
import { readCorpus, readPart } from "../node/fsload.ts";

export const REPO = path.resolve(import.meta.dirname, "../..");
export const PAPERS_DIR = path.join(REPO, "tests/fixtures/search/index_small");
export const NOTES_DIR = path.join(import.meta.dirname, "fixtures/notes_small");

export function rawFixtures(): { papers: RawCorpus; notes: RawCorpus } {
  return { papers: readCorpus(PAPERS_DIR)!, notes: readCorpus(NOTES_DIR)! };
}

export function fixtureCorpora(): Corpora {
  const f = rawFixtures();
  return buildCorpora(f.papers, f.notes);
}

export function fixtureEngine(): Engine {
  return new Engine(fixtureCorpora());
}

export const fixtureParts = () => ({ papers: readPart(PAPERS_DIR), notes: readPart(NOTES_DIR) });

/** The same hash embedder the Python fixture builder uses (md5 of each lowercase word → a dimension). */
export function fakeVec(text: string, dims = 8): Float32Array {
  const v = new Float64Array(dims);
  for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const h = BigInt("0x" + crypto.createHash("md5").update(w).digest("hex"));
    v[Number(h % BigInt(dims))] += 1;
  }
  if (!v.some((x) => x)) v[0] = 1;
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return Float32Array.from(v, (x) => x / n);
}
