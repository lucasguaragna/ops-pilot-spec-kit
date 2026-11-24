import { EmbeddingError } from "../domain/errors.ts";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../memory/embeddings.ts";

/**
 * A 384-value unit vector from axis → weight, so a test can aim a score on purpose:
 * `dot(unitVector({ 0: 1 }), unitVector({ 0: 0.95, 1: Math.sqrt(1 - 0.95 ** 2) }))` is 0.95.
 */
export function unitVector(weights: Record<number, number>): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  for (const [axis, weight] of Object.entries(weights)) vector[Number(axis)] = weight;
  const length = Math.hypot(...vector);
  if (length === 0) throw new Error("unitVector needs at least one non-zero weight");
  return vector.map((value) => value / length);
}

/** A vector whose dot product with `unitVector({ [axis]: 1 })` is `score`. */
export function scoredAgainst(axis: number, score: number, otherAxis = EMBEDDING_DIMENSIONS - 1): Float32Array {
  return unitVector({ [axis]: score, [otherAxis]: Math.sqrt(1 - score * score) });
}

/** Table-driven Embedder for tests. It must never be wired into `src/index.ts`. */
export class FakeEmbedder implements Embedder {
  /** Every text it was asked to embed, in order. */
  readonly calls: string[] = [];
  private readonly vectors: Map<string, Float32Array>;
  private readonly failing: boolean;

  constructor(vectors: Record<string, Float32Array> = {}, options: { failing?: boolean } = {}) {
    this.vectors = new Map(Object.entries(vectors));
    this.failing = options.failing ?? false;
  }

  async embed(text: string): Promise<Float32Array> {
    this.calls.push(text);
    if (this.failing) throw new EmbeddingError("fake embedder set to fail");
    const vector = this.vectors.get(text);
    // A text missing from the table is a mistake in the test, so it fails loudly.
    if (!vector) throw new EmbeddingError(`no fake vector for "${text}"`);
    return vector;
  }
}
