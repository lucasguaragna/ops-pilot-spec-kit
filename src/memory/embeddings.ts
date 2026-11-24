import { EmbeddingError } from "../domain/errors.ts";

/** The ONNX export of sentence-transformers/all-MiniLM-L6-v2 that Transformers.js loads. */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/** all-MiniLM-L6-v2 produces 384 values per text. */
export const EMBEDDING_DIMENSIONS = 384;

/** Turns text into a vector whose dot product with another one measures how close their meanings are. */
export interface Embedder {
  /** A unit-length vector of EMBEDDING_DIMENSIONS values. Throws EmbeddingError on failure. */
  embed(text: string): Promise<Float32Array>;
}

/** Pure: the sum of products. For unit-length vectors this is the cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Vector lengths differ: ${a.length} and ${b.length}`);
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += a[index]! * b[index]!;
  return sum;
}

/** One loaded model: text in, pooled and normalized values out. */
export type Extract = (text: string) => Promise<ArrayLike<number>>;

/**
 * Loads the model on the first `embed`, once per process. The promise is cached, not the result, so
 * requests that arrive while the model is still loading share one load. A failed load is forgotten,
 * so the next request tries again instead of failing forever.
 */
export function createLazyEmbedder(load: () => Promise<Extract>): Embedder {
  let loading: Promise<Extract> | undefined;
  const loaded = (): Promise<Extract> => {
    if (loading) return loading;
    const attempt = Promise.resolve().then(load);
    loading = attempt;
    attempt.catch(() => {
      if (loading === attempt) loading = undefined;
    });
    return attempt;
  };

  return {
    async embed(text) {
      let values: ArrayLike<number>;
      try {
        values = await (await loaded())(text);
      } catch (error) {
        throw new EmbeddingError(error instanceof Error ? error.message : String(error));
      }
      if (values.length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingError(`expected ${EMBEDDING_DIMENSIONS} values, got ${values.length}`);
      }
      return values instanceof Float32Array ? values : Float32Array.from(values);
    },
  };
}

/**
 * The library is imported on first use, so importing this module (the store, the tests) never
 * loads the ONNX runtime. `dtype` is pinned, so the scores the thresholds were checked on cannot
 * drift with a library default.
 */
async function loadLocalModel(): Promise<Extract> {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "fp32" });
  return async (text) => (await extractor(text, { pooling: "mean", normalize: true })).data as ArrayLike<number>;
}

/** The process-wide embedder: all-MiniLM-L6-v2, run locally, loaded lazily. */
export const localEmbedder: Embedder = createLazyEmbedder(loadLocalModel);
