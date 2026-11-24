# Research: Semantic Memory

All findings below were checked against the Transformers.js 4.3.2 docs (Context7,
`/huggingface/transformers.js/4.3.2`) and against a probe that ran the real model in a scratch
directory outside the repository on 2026-11-20.

## R1. Embedding library and model

- **Decision**: `@huggingface/transformers` 4.3.2, `pipeline("feature-extraction",
  "Xenova/all-MiniLM-L6-v2", { dtype: "fp32" })`, called with `{ pooling: "mean", normalize: true }`.
  The result's `.data` is a `Float32Array` of 384 values.
- **Rationale**: It is what the request asked for. `Xenova/all-MiniLM-L6-v2` is the ONNX export of
  `sentence-transformers/all-MiniLM-L6-v2` that the library loads. Mean pooling plus normalization
  is how this model was trained to produce sentence embeddings, and normalization makes every vector
  unit length, so the dot product equals cosine similarity (FR-005). `dtype: "fp32"` is the Node
  default, but it is set explicitly so the scores the thresholds were tuned on cannot drift with a
  library default.
- **Probe results**: first load 4.8 s including the download; one embedding of a short sentence
  about 1 ms once loaded; files cached: `onnx/model.onnx` (90 MB), `tokenizer.json` (0.7 MB), two
  small configs.
- **Alternatives considered**: a hosted embedding API (rejected: FR-008 requires local inference
  and it would need a secret); `dtype: "q8"` (23 MB, faster, but its scores differ slightly from the
  ones the thresholds below were checked on).

## R2. Lazy singleton loader

- **Decision**: `src/memory/embeddings.ts` keeps one module-level `Promise<FeatureExtractionPipeline>
  | undefined`. The first `embed()` call creates it; later calls await the same promise. If the
  promise rejects, the slot is cleared so the next request retries instead of failing forever. Any
  failure is wrapped in `EmbeddingError`.
- **Rationale**: Storing the promise, not the resolved pipeline, means two requests that arrive
  while the model is still loading share one load (this is the pattern in the library's Node
  tutorial). Clearing on rejection handles a transient download failure. FR-008 and SC-006.
- **Alternatives considered**: loading at startup (rejected: the request asked for lazy loading, and
  it would slow every `npm run dev` even when no request has a user id); a class with a static
  instance (same behaviour, more ceremony).

## R3. Embedder as an injected dependency

- **Decision**: `interface Embedder { embed(text: string): Promise<Float32Array> }`. The real one is
  `localEmbedder` from `embeddings.ts`; tests use `FakeEmbedder` from `src/testing/fake-embedder.ts`,
  which maps known texts to fixed 384-value unit vectors built from a few chosen axes.
- **Rationale**: Only one test needs the real model (SC-001). Everything else (contract, dedup,
  ranking, HTTP) stays fast, offline, and exact. A table-driven fake lets a test pin a score such as
  0.95 or 0.1 on purpose.
- **Alternatives considered**: a bag-of-words hash embedder (rejected: its scores are hard to aim
  at a threshold, and it would teach nothing about meaning).

## R4. Thresholds and the test pair for "no word in common"

- **Decision**: duplicate when `score > 0.92`; recalled when `score >= 0.3`; at most 3. The real-model
  test uses:
  - fact "The payments team owns the checkout service", query "who should I page about failed
    purchases?" — score 0.357 (no shared word)
  - fact "I prefer answers in short bullet lists", query "keep replies brief, please" — score 0.439
    (no shared word)
  - control: "my favourite colour is green" against the first fact — score 0.076 (not recalled)
- **Dedup probe**: "the payments team is responsible for the checkout service" against the first
  fact scored 0.945 (duplicate); "payments owns checkout" scored 0.836 (kept as a separate fact).
  The spec example in User Story 2 was corrected to match.
- **Rationale**: The pairs clear 0.3 with a margin of 0.057 and 0.139, and the control is far below.
  The test asserts only the threshold side, never an exact score, so a minor library update does not
  break it.
- **Boundary rule**: the boundaries "exactly 0.92 is not a duplicate" and "exactly 0.3 is recalled"
  are tested on the pure functions with literal numbers. Building a Float32 vector pair whose dot
  product is exactly 0.92 is not possible (Float32 rounds 0.92 to 0.92000001…), so store-level
  tests use scores clearly on each side (0.95 / 0.9, 0.35 / 0.25).

## R5. Storing the embedding

- **Decision**: `embedding BLOB NOT NULL CHECK (length(embedding) = 1536)`. Write
  `new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)`; read by copying the bytes
  into a fresh `Float32Array` (`new Float32Array(Uint8Array.from(blob).buffer)`).
- **Rationale**: 384 × 4 bytes = 1536. `node:sqlite` returns a BLOB as a `Uint8Array` whose
  `byteOffset` is not guaranteed to be a multiple of 4, so viewing it directly as a `Float32Array`
  can throw; copying is safe and costs nothing at this size. The CHECK is the database-level
  defence for a vector of the wrong model or size. Byte order is the platform's (little-endian on
  every machine this runs on); the file is not meant to move between architectures.
- **Alternatives considered**: JSON text (rejected: 3-4× larger and slower to parse; the request
  asked for a BLOB); the `sqlite-vec` extension (rejected: a native extension and a vector index are
  not needed at tens to hundreds of facts per user).

## R6. Recall and dedup algorithm

- **Decision**: both load the user's rows with one prepared `SELECT … WHERE user_id = ? ORDER BY id`,
  decode them, and hand them to pure functions in `memory-store.ts`:
  - `rankMemories(query, rows, { limit: 3, minScore: 0.3 })`: score each with `dot`, keep
    `score >= minScore`, sort by score descending then id descending (newest first on a tie), take
    `limit`.
  - `findDuplicate(vector, rows, 0.92)`: the row with the highest score if that score is above the
    threshold, otherwise `undefined`.
- **Rationale**: A linear scan of a few hundred 384-value vectors is well under a millisecond. Ids
  are SQLite rowids, which only grow, so "newest" by id never ties (timestamps can). Keeping the math
  pure keeps it testable without a database (Principle IV).
- **Concurrency**: `remember` awaits the embedding first, then runs the scan and the insert with no
  `await` between them. `DatabaseSync` is synchronous, so in this single process two near-duplicate
  `remember` calls cannot both miss each other.

## R7. Getting the facts into the prompt

- **Decision**: a pure `composeMemoryInput(memories, input)` and a `withMemories(strategy, memories)`
  decorator in `src/agents/memories.ts`, composed as
  `withHistory(withMemories(strategy, recalled), history)`.
- **Rationale**: Same pattern as `withHistory` (feature 007), so every strategy and reflection get
  the facts with no strategy code (FR-011). With `withHistory` outside, the final text reads: facts
  block, then the conversation so far, then the current request. The reverse order would put the
  facts under "Current request:". An empty recall returns the input unchanged (FR-013).
- **Format**:

  ```text
  Facts remembered about this engineer (best match first; they may be out of date):
  - [memory 7] The payments team owns the checkout service

  <input as composed by withHistory>
  ```

  The `[memory N]` id is what `forget_fact` takes (FR-018).

## R8. Memory tools and the user id

- **Decision**: two tools, `remember_fact { fact }` and `forget_fact { id }`, defined in
  `src/tools/memory-definitions.ts` (name, description, zod schema) and built by
  `createMemoryTools(memories, userId)` in `src/agents/memory-tools.ts`. `userId` is captured in the
  closure and is not part of either schema. `runChat` appends them to the tools from
  `createDependencies()` only when the request has a `userId`, before `createStrategy`.
- **Rationale**: FR-016 and FR-017. The model never sees a user id field, so it cannot act for
  another user. Keeping them out of `TOOL_DEFINITIONS` keeps the MCP server unchanged (out of scope).
  Building the tools is pure, so an unknown strategy (422) still writes nothing.
- **Errors**: `forget_fact` on an unknown id or another user's id throws `MemoryNotFoundError`
  (a `DomainError`), which goes back to the model as `Error: …` text. Invalid tool input (empty fact,
  over 500 characters, non-integer id) is rejected by the tool schema. A test with the scripted chat
  model pins that the run continues and the model gets an error message (FR-019). This was not
  checked against the LangChain 1.x docs during planning: if the agent's tool node re-throws schema
  errors instead, the tool takes a loose schema and validates with `safeParse` inside the handler,
  returning `Error: …` text. An
  `EmbeddingError` inside `remember_fact` is not a `DomainError`, so it fails the run (502) like any
  infrastructure error.
- **Async helper**: `runToolText` is synchronous; a `runToolTextAsync` sibling in `definitions.ts`
  wraps the awaited store call with the same rule (domain errors become text, the rest re-throws).

## R9. Order inside `runChat` and failure behaviour

- **Decision**: build dependencies (+ memory tools when `userId`) → `createStrategy` (422) →
  `lastMessages` when `conversationId` (404) → `recall` when `userId` → `create()` when no
  `conversationId` → run under the timeout → save the completed exchange.
- **Rationale**: Recall comes before creating a conversation, so a recall failure never leaves an
  empty conversation behind, and a 404 never pays for an embedding. Recall runs outside the run
  timeout: the timeout bounds the agent, and the first-request model load (seconds) would otherwise
  eat into it.
- **Recall failure**: `recall` throws `EmbeddingError`; the controller logs
  `Memory recall failed: <message>` and lets it reach the existing 500 handler. The spec's edge case
  prefers a visible failure over an answer silently missing the user's memories.

## R10. Dependency install and tests

- **Install**: npm on this machine blocks install scripts by default. The probe showed
  `onnxruntime-node`'s blocked postinstall is not needed on macOS: the CPU binaries ship inside the
  package (`bin/napi-v6`). No `allowScripts` change is required.
- **Model cache**: the default, `node_modules/@huggingface/transformers/.cache/`. It is outside
  `data/`, already ignored with `node_modules/`, and is shared by the app and the tests. Deleting
  `node_modules` means one more download.
- **Real-model test**: `src/memory/embeddings.test.ts` loads the real model, with a 300 s test
  timeout for the first download. It is part of `npm test` by default. Setting
  `OPSPILOT_SKIP_MODEL_TESTS=1` skips it (and prints why) for an offline machine; this is an escape
  hatch, not the default.
- **Constitution**: adding a dependency does not replace any stack element, so no amendment is
  needed (the constitution forbids only replacements).
