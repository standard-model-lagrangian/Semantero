import test from "node:test";
import assert from "node:assert";
import { BM25Index, type PaperMetadata, type ChunkDocument } from "../src/core/bm25.ts";

const samplePapers: PaperMetadata[] = [
  {
    key: "KEY1",
    citekey: "roth2023tunable",
    title: "Tunable hydrogel viscoelasticity modulates human neural maturation",
    authors: ["Roth", "Bauer"],
    year: 2023,
    journal: "Science Advances",
    doi: "10.1126/sciadv.abq7529",
    tags: ["hydrogels", "neural"],
    collections: ["Biomaterials"],
    abstract: "Faster stress relaxation accelerated neuronal maturation.",
  },
  {
    key: "KEY2",
    citekey: "lesavage2022next",
    title: "Next-generation cancer organoids",
    authors: ["LeSavage", "Heilshorn"],
    year: 2022,
    journal: "Nature Materials",
    doi: "10.1038/s41563-022-01256-4",
    tags: ["organoids"],
    collections: ["Oncology"],
    abstract: "Matrix stiffness regulates organoid growth.",
  },
  {
    key: "KEY3",
    citekey: "smith2021polymers",
    title: "Synthetic polymer networks",
    authors: ["Smith"],
    year: 2021,
    journal: "Macromolecules",
    doi: null,
    tags: ["polymers"],
    collections: ["Materials"],
    abstract: "Characterization of synthetic networks.",
  },
];

const sampleChunks: ChunkDocument[] = [
  {
    paper: 0,
    attachmentKey: "ATT1",
    page: 6,
    text: "We tested viscoelasticity and neural response in 3D gels.",
  },
  {
    paper: 1,
    attachmentKey: "ATT2",
    page: 2,
    text: "Organoid models reveal sensitivity to surrounding stiffness and viscoelasticity.",
  },
  {
    paper: 2,
    attachmentKey: "ATT3",
    page: 4,
    text: "Polymer networks exhibit tunable hydrogel properties.",
  },
];

test("title match outranks body match for same term", () => {
  // Query "hydrogel": in paper 0's title (weight 3), but only in paper 2's chunk (weight 1)
  const index = new BM25Index(samplePapers, sampleChunks);
  const results = index.search("hydrogel ");
  assert.ok(results.length >= 2);
  assert.strictEqual(results[0].paperIndex, 0); // paper 0 title match outranks paper 2 chunk match
});

test("prefix on the last token, with or without a trailing space", () => {
  const index = new BM25Index(samplePapers, sampleChunks);

  // "viscoel" matches "viscoelasticity"
  const res = index.search("viscoel");
  assert.ok(res.length > 0);
  assert.strictEqual(res[0].paperIndex, 0);

  // Typing the space (or more whitespace, or punctuation) after the last word changes nothing
  for (const q of ["viscoel ", "viscoel  ", " viscoel\t", "viscoel."]) assert.deepStrictEqual(index.search(q), res, q);
});

test("paper keyword score is max of metadata and best chunk", () => {
  const index = new BM25Index(samplePapers, sampleChunks);
  const results = index.search("organoid stiffness");
  assert.ok(results.length > 0);
  const top = results[0];
  assert.strictEqual(top.paperIndex, 1);
  assert.ok(top.score > 0);
  assert.ok(top.bestChunkScore !== undefined);
  assert.ok(top.metadataScore !== undefined);
  assert.strictEqual(top.score, Math.max(top.metadataScore, top.bestChunkScore));
});

test("author surname query ranks that author's papers first", () => {
  const index = new BM25Index(samplePapers, sampleChunks);
  const results = index.search("LeSavage ");
  assert.ok(results.length > 0);
  assert.strictEqual(results[0].paperIndex, 1);
});

test("citekey exact match ranks first", () => {
  const index = new BM25Index(samplePapers, sampleChunks);
  const results = index.search("roth2023tunable");
  assert.ok(results.length > 0);
  assert.strictEqual(results[0].paperIndex, 0);
});

test("zero-score chunk is not set as bestChunkIndex when only metadata matches", () => {
  const papers: PaperMetadata[] = [
    {
      key: "K1",
      citekey: "bauer2023",
      title: "Work by Jane Bauer",
      authors: ["Bauer"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: "Abstract mentioning Bauer.",
    },
  ];
  const chunks: ChunkDocument[] = [
    {
      paper: 0,
      attachmentKey: "ATT1",
      page: 1,
      text: "Completely unrelated text without any matching words.",
    },
  ];
  const index = new BM25Index(papers, chunks);
  const results = index.search("Bauer");
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].paperIndex, 0);
  assert.ok(results[0].metadataScore > 0);
  assert.strictEqual(results[0].bestChunkScore, 0);
  assert.strictEqual(results[0].bestChunkIndex, undefined);
});

// --- Phase 0b: Tests K1–K8 ---

test("K1 short unfinished word ignored", () => {
  const index = new BM25Index(samplePapers, sampleChunks);
  // "s" gives the same ranking as "" (empty)
  const resS = index.search("s");
  const resEmpty = index.search("");
  assert.deepStrictEqual(resS, resEmpty);
  assert.strictEqual(resS.length, 0);

  // "stiff g" gives the same ranking as "stiff" finished by another word ("stiff in": a stopword adds nothing)
  const resStiffG = index.search("stiff g");
  const resStiffSpace = index.search("stiff in");
  assert.strictEqual(resStiffG.length, resStiffSpace.length);
  for (let i = 0; i < resStiffG.length; i++) {
    assert.strictEqual(resStiffG[i].paperIndex, resStiffSpace[i].paperIndex);
    assert.ok(Math.abs(resStiffG[i].score - resStiffSpace[i].score) < 1e-9);
  }
});

test("K2 a short word that's a real term still matches exactly", () => {
  const papers: PaperMetadata[] = [
    {
      key: "K1",
      citekey: "paper1",
      title: "Targeting il pathways in 3d models",
      authors: ["Author"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: "Study on il and 3d constructs.",
    },
    {
      key: "K2",
      citekey: "paper2",
      title: "Other work",
      authors: ["Author2"],
      year: 2022,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: "Unrelated.",
    },
  ];
  const index = new BM25Index(papers, []);

  // A short last word matches only when it contains a digit ("3d", "6"); letters-only
  // short words ("il") wait for a third letter, and a trailing space does not change that.
  assert.strictEqual(index.search("il").length, 0);
  assert.strictEqual(index.search("il ").length, 0);
  // Not in last place, a short word is a finished word and matches exactly
  const resIlDone = index.search("il pathways");
  assert.ok(resIlDone.length > 0);
  assert.strictEqual(resIlDone[0].paperIndex, 0);

  const res3d = index.search("3d");
  assert.ok(res3d.length > 0);
  assert.strictEqual(res3d[0].paperIndex, 0);
});

test("K1b single letters in the real vocabulary (from \"cell's\", \"g of\") don't match while typing", () => {
  const papers: PaperMetadata[] = [
    { key: "A", citekey: "a", title: "The cell's response to stiff gels", authors: ["X"], year: 2023, journal: null, doi: null, tags: [], collections: [], abstract: "5 g of polymer per stiff matrix." },
    { key: "B", citekey: "b", title: "Stiff matrices and soft tissue", authors: ["Y"], year: 2022, journal: null, doi: null, tags: [], collections: [], abstract: "Nothing else." },
  ];
  const index = new BM25Index(papers, []);
  assert.strictEqual(index.search("s").length, 0, "\"s\" alone returns nothing");
  assert.strictEqual(index.search("c").length, 0);
  const g = index.search("stiff g");
  const sp = index.search("stiff ");
  assert.deepStrictEqual(g.map((r) => [r.paperIndex, r.score]), sp.map((r) => [r.paperIndex, r.score]));
  // a digit token still matches while unfinished
  assert.ok(index.search("5").length > 0);
});

test("K3 three-letter prefix expands", () => {
  const papers: PaperMetadata[] = [
    {
      key: "K1",
      citekey: "p1",
      title: "Study of viscoelasticity",
      authors: ["A"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: null,
    },
    {
      key: "K2",
      citekey: "p2",
      title: "Measuring viscosity in fluids",
      authors: ["B"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: null,
    },
    {
      key: "K3",
      citekey: "p3",
      title: "Completely unrelated title",
      authors: ["C"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: null,
    },
  ];
  const index = new BM25Index(papers, []);
  const res = index.search("vis");
  assert.strictEqual(res.length, 2);
  const foundPapers = new Set(res.map((r) => r.paperIndex));
  assert.ok(foundPapers.has(0));
  assert.ok(foundPapers.has(1));
  assert.ok(!foundPapers.has(2));
});

test("K4 at most 64 expansions, highest document frequency kept", () => {
  // Create 500 stiff* terms across chunks/papers with varying df
  const papers: PaperMetadata[] = [];
  const chunks: ChunkDocument[] = [];

  // Generate 500 terms: stiff000 through stiff499
  // Give term stiff000 through stiff063 df = 2
  // Give terms stiff064 through stiff499 df = 1
  for (let i = 0; i < 500; i++) {
    const term = `stiff${i.toString().padStart(3, "0")}`;
    papers.push({
      key: `K${i}`,
      citekey: `cite${i}`,
      title: `Paper ${i} mentioning ${term}`,
      authors: ["Author"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: i < 64 ? `Extra mention of ${term}` : null,
    });
    if (i < 64) {
      chunks.push({
        paper: i,
        attachmentKey: `ATT${i}`,
        page: 1,
        text: `Chunk also containing ${term}`,
      });
    }
  }

  const index = new BM25Index(papers, chunks);
  const [start, end] = index.findPrefixRange("stiff");
  assert.strictEqual(end - start, 500);

  // Search with prefix "stiff"
  const results = index.search("stiff");
  // Should have expanded to at most 64 terms, and since each paper has one term, exactly 64 papers match
  assert.strictEqual(results.length, 64);
  // The 64 kept should be papers 0..63 (the ones with df = 2)
  for (const r of results) {
    assert.ok(r.paperIndex < 64, `Expected paperIndex < 64, got ${r.paperIndex}`);
  }
});

test("K5 a typed word that is a term ranks its exact matches above longer words", () => {
  const papers: PaperMetadata[] = [
    {
      key: "K1",
      citekey: "p1",
      title: "Cellular morphology in tissue",
      authors: ["Author"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: null,
    },
    {
      key: "K2",
      citekey: "p2",
      title: "Single cell analysis",
      authors: ["Author2"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: null,
    },
  ];
  const index = new BM25Index(papers, []);

  // "cell" matches "cellular" too, but paper 1 ("cell") ranks first, with or without a trailing space
  for (const q of ["cell", "cell "]) {
    const results = index.search(q);
    assert.deepStrictEqual(results.map((r) => r.paperIndex), [1, 0], q);
    assert.ok(results[0].score > results[1].score, q);
  }

  // A non-last word stays exact
  assert.deepStrictEqual(index.search("cell morphology").map((r) => r.paperIndex), [0, 1]);
});

test("K5b a rare longer word scores no higher than the word typed", () => {
  const paper = (key: string, title: string): PaperMetadata => ({
    key, citekey: key, title, authors: ["A"], year: 2023, journal: null, doi: null, tags: [], collections: [], abstract: null,
  });
  // "cells121" (a glued citation number) is in one paper; "cells" is in many, so its idf is far lower
  const papers = [paper("J", "Organoid cells121 culture")];
  for (let i = 0; i < 20; i++) papers.push(paper(`C${i}`, `Stem cells study ${i}`));
  const index = new BM25Index(papers, []);
  const results = index.search("cells");
  const junk = results.find((r) => r.paperIndex === 0)!;
  const real = results.find((r) => r.paperIndex === 1)!;
  assert.ok(junk.score <= real.score, `${junk.score} > ${real.score}`);
});

test("K6 ranking unchanged for completed-word queries", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");

  const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../tests/fixtures/search/index_small");
  const papers: PaperMetadata[] = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "papers.json"), "utf8"));
  const chunks: ChunkDocument[] = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "chunks.json"), "utf8"));
  const goldensPath = path.resolve(import.meta.dirname, "goldens.json");
  const goldens = JSON.parse(fs.readFileSync(goldensPath, "utf8"));

  const index = new BM25Index(papers, chunks);

  // First 20 queries are completed-word queries
  for (let i = 0; i < 20; i++) {
    const g = goldens[i];
    const results = index.search(g.query);
    assert.strictEqual(
      results.length,
      g.keywordRes.length,
      `Query "${g.query}" length mismatch: got ${results.length}, expected ${g.keywordRes.length}`
    );
    for (let j = 0; j < results.length; j++) {
      assert.strictEqual(results[j].paperIndex, g.keywordRes[j].paperIndex, `Query "${g.query}" paperIndex mismatch at rank ${j}`);
      assert.ok(
        Math.abs(results[j].score - g.keywordRes[j].score) < 1e-6,
        `Query "${g.query}" score mismatch at rank ${j}: ${results[j].score} vs ${g.keywordRes[j].score}`
      );
    }
  }
});

test("K7 sorted vocabulary binary search agrees with a linear scan", () => {
  // Build a test vocabulary with 2,000 synthetic terms
  const vocabSet = new Set<string>();
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < 2000; i++) {
    let word = "";
    const len = 3 + (i % 6);
    for (let c = 0; c < len; c++) {
      word += letters[Math.floor(((i * 31 + c * 17 + i * i) & 0x7fffffff) % letters.length)];
    }
    vocabSet.add(word);
  }
  const papers: PaperMetadata[] = [
    {
      key: "K1",
      citekey: "p1",
      title: Array.from(vocabSet).join(" "),
      authors: ["Author"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: null,
    },
  ];
  const index = new BM25Index(papers, []);
  const sortedVocab = (index as any).sortedVocab as string[];

  // 1,000 random prefixes
  for (let i = 0; i < 1000; i++) {
    let prefix = "";
    const pLen = 1 + (i % 4);
    for (let c = 0; c < pLen; c++) {
      prefix += letters[Math.floor(((i * 47 + c * 23 + 101) & 0x7fffffff) % letters.length)];
    }

    const [start, end] = index.findPrefixRange(prefix);
    const binaryMatches = sortedVocab.slice(start, end);

    const linearMatches = sortedVocab.filter((v) => v.startsWith(prefix));
    assert.deepStrictEqual(
      binaryMatches,
      linearMatches,
      `Prefix binary search mismatch for "${prefix}": range [${start}, ${end}) vs linear count ${linearMatches.length}`
    );
  }
});

test("K8 unicode and odd input don't crash", () => {
  const index = new BM25Index(samplePapers, sampleChunks);
  const oddInputs = [
    "Φ29",
    "β-catenin",
    "naïve",
    "🎉 🧬 🔬",
    "a ".repeat(5000), // 10 kB of "a "
    "the of and to a in", // only stopwords
    "., -;: !? ()[]{}", // only punctuation
    "",
    "   ",
    "\\@@ \u0000 \uFFFD",
  ];

  for (const input of oddInputs) {
    assert.doesNotThrow(() => {
      const res = index.search(input);
      assert.ok(Array.isArray(res));
    }, `Failed on input: ${input.slice(0, 30)}...`);
  }
});
