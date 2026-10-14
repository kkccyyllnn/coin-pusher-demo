/** Deterministic cosmetic randomness must never consume the gameplay RNG stream. */
export function createPresentationRng(seed = 0x78697869): () => number {
  let value = seed >>> 0 || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x100000000;
  };
}
