/** Dimensions assumed when a manifest's `dims` is missing or invalid (its vectors are unusable then anyway). */
export const FALLBACK_DIMS = 1024;

/**
 * Whether an index's vectors file can be used: the manifest's `dims` is a positive integer and the file holds exactly
 * rows × dims float32 values. `byteLength` null: there is no vectors file. `reason` is null when the vectors are usable
 * (or when there are none and no rows need them); otherwise it says why semantic search is off. `dims` is the
 * manifest's, or FALLBACK_DIMS when invalid.
 */
export function checkVectors(manifestDims: unknown, rows: number, byteLength: number | null): { dims: number; reason: string | null } {
  const dimsOk = Number.isInteger(manifestDims) && (manifestDims as number) > 0;
  const dims = dimsOk ? (manifestDims as number) : FALLBACK_DIMS;
  if (byteLength === null) return { dims, reason: rows > 0 ? "no vectors" : null };
  if (!dimsOk) return { dims, reason: "index dims invalid" };
  if (byteLength !== rows * dims * 4) return { dims, reason: "vectors file invalid" };
  return { dims, reason: null };
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
