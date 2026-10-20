import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Mulberry32 deterministic PRNG
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMON_TERMS = [
  "viscoelasticity",
  "stiffness",
  "hydrogel",
  "chemoresistance",
  "organoids",
  "biopolymers",
  "relaxation",
  "neural",
  "mechanics",
  "constitutive",
  "integrin",
  "maturation",
  "morphogenesis",
  "cancer",
  "matrices",
  "degradation",
  "signaling",
  "modulus",
  "elastic",
  "viscous",
  "cellular",
  "tissue",
  "extracellular",
  "collagen",
  "stiff",
  "cell",
  "organoid",
  "biomaterials",
  "network",
  "stress",
  "strain",
  "matrix",
  "modulate",
  "growth",
  "response",
  "modelling",
  "experimental",
  "frequency",
  "permissive",
  "synaptic",
];

const AUTHORS = [
  "Roth",
  "Bauer",
  "LeSavage",
  "Heilshorn",
  "Wang",
  "Zhang",
  "Johnson",
  "Muller",
  "Schmidt",
  "Kim",
  "Chen",
  "Smith",
  "Taylor",
  "Brown",
  "Wilson",
  "Davis",
];

const JOURNALS = [
  "Nature Materials",
  "Science Advances",
  "Nature Biomedical Engineering",
  "Biophysical Journal",
  "Biomaterials",
  "Advanced Materials",
  "Acta Biomaterialia",
];

export interface SyntheticIndexOptions {
  outDir: string;
  numPapers?: number;
  chunksPerPaper?: number;
  dims?: number;
  seed?: number;
}

export function buildSyntheticIndex(options: SyntheticIndexOptions): {
  papersCount: number;
  chunksCount: number;
  vectorBytes: number;
  contentHash: string;
} {
  const {
    outDir,
    numPapers = 500,
    chunksPerPaper = 50,
    dims = 1024,
    seed = 42,
  } = options;

  const rand = mulberry32(seed);

  // 1. Build Zipf vocabulary of 30,000 terms
  const VOCAB_SIZE = 30000;
  const vocab: string[] = [];
  for (let i = 0; i < COMMON_TERMS.length; i++) {
    vocab.push(COMMON_TERMS[i]);
  }
  for (let i = vocab.length; i < VOCAB_SIZE; i++) {
    vocab.push(`term${i}`);
  }

  // Precompute Zipf CDF (s = 1)
  const cdf = new Float64Array(VOCAB_SIZE);
  let cdfSum = 0;
  for (let i = 0; i < VOCAB_SIZE; i++) {
    cdfSum += 1.0 / (i + 1);
    cdf[i] = cdfSum;
  }
  for (let i = 0; i < VOCAB_SIZE; i++) {
    cdf[i] /= cdfSum;
  }

  function sampleWord(): string {
    const u = rand();
    let low = 0;
    let high = VOCAB_SIZE - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (cdf[mid] < u) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return vocab[low];
  }

  function sampleSentence(minWords = 8, maxWords = 15): string {
    const count = minWords + Math.floor(rand() * (maxWords - minWords + 1));
    const words: string[] = [];
    for (let i = 0; i < count; i++) {
      words.push(sampleWord());
    }
    const s = words.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1) + ".";
  }

  function sampleParagraph(numSentences = 3): string {
    const sents: string[] = [];
    for (let i = 0; i < numSentences; i++) {
      sents.push(sampleSentence());
    }
    return sents.join(" ");
  }

  // 2. Generate Papers and Chunks
  fs.mkdirSync(outDir, { recursive: true });

  const papers: any[] = [];
  const chunks: any[] = [];
  let currentRow = 0;

  for (let pIdx = 0; pIdx < numPapers; pIdx++) {
    const author1 = AUTHORS[Math.floor(rand() * AUTHORS.length)];
    const author2 = AUTHORS[Math.floor(rand() * AUTHORS.length)];
    const authors = author1 === author2 ? [author1] : [author1, author2];
    const year = 2015 + Math.floor(rand() * 11);
    const citekey = `${author1.toLowerCase()}${year}_p${pIdx}`;
    const titleWords = [sampleWord(), sampleWord(), sampleWord(), sampleWord(), sampleWord()];
    const title = titleWords.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const abstract = sampleParagraph(3);
    const abstractRow = currentRow++;

    papers.push({
      key: `KEY_${pIdx.toString().padStart(4, "0")}`,
      citekey,
      title,
      authors,
      year,
      journal: JOURNALS[Math.floor(rand() * JOURNALS.length)],
      doi: `10.1038/synth.${pIdx}`,
      tags: [sampleWord(), sampleWord()],
      collections: ["Synthetic"],
      abstract,
      pdfs: [
        {
          attachmentKey: `ATT_${pIdx}`,
          pages: 15,
          hasText: true,
        },
      ],
      abstractRow,
    });

    for (let c = 0; c < chunksPerPaper; c++) {
      const page = 1 + Math.floor(c / 4);
      const text = sampleParagraph(3);
      const row = currentRow++;
      chunks.push({
        paper: pIdx,
        attachmentKey: `ATT_${pIdx}`,
        page,
        text,
        row,
      });
    }
  }

  // 3. Generate Vectors
  // Total rows = currentRow = numPapers * (1 + chunksPerPaper)
  const totalRows = currentRow;
  const vecPath = path.join(outDir, "vectors.f32");
  const fd = fs.openSync(vecPath, "w");

  // Write in batches of 500 rows to keep memory low
  const batchRows = 500;
  const batchFloats = batchRows * dims;
  const floatArr = new Float32Array(batchFloats);
  const byteBuf = Buffer.from(floatArr.buffer);
  const hasher = crypto.createHash("sha256");

  let remaining = totalRows;
  while (remaining > 0) {
    const currentBatch = Math.min(remaining, batchRows);
    const countFloats = currentBatch * dims;

    for (let r = 0; r < currentBatch; r++) {
      let sumSq = 0;
      const offset = r * dims;
      for (let d = 0; d < dims; d++) {
        // pseudo-random float in [-1, 1]
        const val = rand() * 2 - 1;
        floatArr[offset + d] = val;
        sumSq += val * val;
      }
      // normalize
      const invNorm = 1.0 / (Math.sqrt(sumSq) || 1.0);
      for (let d = 0; d < dims; d++) {
        floatArr[offset + d] *= invNorm;
      }
    }

    const sliceBuf = Buffer.from(floatArr.buffer, 0, countFloats * 4);
    fs.writeSync(fd, sliceBuf);
    hasher.update(sliceBuf);
    remaining -= currentBatch;
  }
  fs.closeSync(fd);

  // 4. Content Hash
  // spec 0.2: papers, chunks, row order, hash of vector bytes
  const vectorHash = hasher.digest("hex");
  const contentHasher = crypto.createHash("sha256");
  contentHasher.update(JSON.stringify(papers));
  contentHasher.update(JSON.stringify(chunks));
  contentHasher.update(vectorHash);
  const contentHash = contentHasher.digest("hex");

  // 5. Write JSON files
  const manifest = {
    format: 1,
    built_at: "2026-10-20T00:00",
    model: "qwen3-embedding:0.6b",
    dims,
    query_instruction: "Given a description of what a paper found or showed, retrieve that paper",
    chunker: "pages-v1",
    papers: papers.length,
    chunks: chunks.length,
    content_hash: contentHash,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "papers.json"), JSON.stringify(papers, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "chunks.json"), JSON.stringify(chunks, null, 2) + "\n");

  return {
    papersCount: papers.length,
    chunksCount: chunks.length,
    vectorBytes: totalRows * dims * 4,
    contentHash,
  };
}

if (process.argv[1] && process.argv[1].endsWith("make-synthetic-index.ts")) {
  const targetDir = process.argv[2] || path.resolve(import.meta.dirname, "../test/fixtures/synthetic_index");
  const t0 = performance.now();
  console.log(`Generating synthetic index at ${targetDir}...`);
  const res = buildSyntheticIndex({ outDir: targetDir });
  const elapsed = (performance.now() - t0).toFixed(0);
  console.log(`Done in ${elapsed} ms: ${res.papersCount} papers, ${res.chunksCount} chunks, ${(res.vectorBytes / 1024 / 1024).toFixed(1)} MB vectors.`);
}
