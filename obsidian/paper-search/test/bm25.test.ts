import test from "node:test";
import assert from "node:assert";
import { BM25Index, type PaperMetadata, type ChunkDocument } from "../src/bm25.ts";

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

test("prefix on incomplete last token", () => {
  const index = new BM25Index(samplePapers, sampleChunks);

  // Incomplete token "viscoel" matches "viscoelasticity"
  const incompleteRes = index.search("viscoel");
  assert.ok(incompleteRes.length > 0);
  assert.strictEqual(incompleteRes[0].paperIndex, 0);

  // Complete token "viscoel " (with space) should NOT match as prefix
  const completeRes = index.search("viscoel ");
  assert.strictEqual(completeRes.length, 0);
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
