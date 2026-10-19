export interface VectorMatch {
  row: number;
  score: number;
}

export function loadVectors(buffer: ArrayBuffer, rows: number, dims: number): Float32Array {
  const expectedBytes = rows * dims * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `Vector file length (${buffer.byteLength}) does not match expected rows (${rows}) * dims (${dims}) * 4 = ${expectedBytes}`
    );
  }
  return new Float32Array(buffer);
}

export function truncateAndNormalize(vec: number[] | Float32Array, targetDims: number): Float32Array {
  const out = new Float32Array(targetDims);
  const n = Math.min(vec.length, targetDims);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = vec[i];
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < targetDims; i++) {
      out[i] /= norm;
    }
  }
  return out;
}

export function dotProduct(
  a: Float32Array,
  b: Float32Array,
  aOffset: number = 0,
  bOffset: number = 0,
  dims: number
): number {
  let sum = 0;
  for (let i = 0; i < dims; i++) {
    sum += a[aOffset + i] * b[bOffset + i];
  }
  return sum;
}

export function topK(
  queryVec: Float32Array,
  allVectors: Float32Array,
  rows: number,
  dims: number,
  k: number
): VectorMatch[] {
  const scores: VectorMatch[] = [];

  for (let r = 0; r < rows; r++) {
    let dot = 0;
    const offset = r * dims;
    for (let d = 0; d < dims; d++) {
      dot += allVectors[offset + d] * queryVec[d];
    }
    scores.push({ row: r, score: dot });
  }

  scores.sort((a, b) => b.score - a.score);
  return k < rows ? scores.slice(0, k) : scores;
}
