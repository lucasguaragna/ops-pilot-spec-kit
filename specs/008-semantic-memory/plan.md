# Implementation Plan: Semantic Memory

**Branch**: `008-semantic-memory` | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-semantic-memory/spec.md`

## Summary

A `MemoryStore` keeps lasting facts per user in a new `memories` table, in the same SQLite file as
the rest of the data. `remember` embeds the fact locally with `all-MiniLM-L6-v2` (Transformers.js,
mean pooling, normalized) and skips it when an existing fact of that user scores above 0.92.
`recall` scores the user's facts by dot product and returns the top 3 that score at least 0.3.
`forget` removes one fact by id. The model loads once, on first use, through a lazy singleton.
`POST /chat` gains an optional `userId`: the service recalls with the engineer's message and a
`withMemories` decorator puts the facts ahead of the input, composed inside `withHistory`. The
agent gets two tools, `remember_fact` and `forget_fact`, bound to that `userId`. Replies report
`metrics.recalledMemories`. A real-model test proves recall works with no word in common; every
other test uses a fake embedder.

## Technical Context

**Language/Version**: TypeScript ESM (`strict: true`) on Node.js 22.13 or newer

**Primary Dependencies**: Express 5, zod 4, LangChain/LangGraph (unchanged). New:
`@huggingface/transformers` 4.3.2 (brings `onnxruntime-node`)

**Storage**: SQLite via `node:sqlite` `DatabaseSync`, file at `OPSPILOT_DB`. New table `memories`
(`id`, `user_id`, `fact`, `embedding` BLOB, `created_at`). Model files cached under
`node_modules/@huggingface/transformers/.cache/`

**Testing**: `node:test` via `tsx`; `":memory:"` databases; `FakeEmbedder`, `FakeMemoryStore`,
`FakeConversationStore`; the scripted chat model; one real-model test (skippable offline with
`OPSPILOT_SKIP_MODEL_TESTS=1`)

**Target Platform**: Local Node.js HTTP service (127.0.0.1 by default)

**Project Type**: Web service (single project)

**Performance Goals**: Model load once per process (about 5 s measured, including the download on
the very first run); one embedding about 1 ms; recall scans a few hundred vectors in well under 1 ms.
Prompt grows by at most 3 short facts

**Constraints**: Embedding runs locally, no network at request time after the first download;
prepared statements only; idempotent DDL; CHECKs mirror the zod limits; tests never touch `data/`;
the MCP server, arena, and bench stay unchanged; the domain `Metrics` type and `ReasoningStrategy`
stay unchanged

**Scale/Scope**: Tens to hundreds of facts per user, single-digit concurrent users, one process

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / rule | How the plan complies | Status |
| --- | --- | --- |
| I. Layered MVC | Controller `chat-controller` → Service `chat-service` → Model `MemoryStore`. Tools call only the store interface. The store is injected through `AppSettings.memories`. | Pass |
| II. Validated boundaries | `userId: UserId.optional()` in `ChatRequest`; `recalledMemories` in `MetricsSchema`; tool inputs are zod schemas; rows parsed with zod. | Pass |
| III. Domain errors at the edge | `MemoryNotFoundError` (a `DomainError`, shown to the model as text) and `EmbeddingError` (infrastructure, logged and turned into 500 in the controller) are classes. | Pass |
| IV. Pure functions | `dot`, `rankMemories`, `findDuplicate`, `toBlob`, `fromBlob`, `composeMemoryInput`, and `toHttpReply` are pure. Model inference and SQL stay in the embedder and the store. | Pass |
| V. Tested and green | Shared contract suite (fake and SQLite), CHECK parity and restart tests, pure-function tests including the exact 0.92 and 0.3 boundaries, tool tests, HTTP tests, one real-model test. | Pass |
| Persistence: path from `OPSPILOT_DB` | Reuses `resolveDbPath`. | Pass |
| Persistence: tests use `":memory:"`; files only in a temp dir | Restart test uses `mkdtemp` and removes the directory. The model cache is not a database and is outside `data/`. | Pass |
| Persistence: prepared statements | Three statements prepared in the constructor; `exec` only runs constant DDL. | Pass |
| Persistence: idempotent schema | `CREATE … IF NOT EXISTS`. | Pass |
| Persistence: CHECK on closed fields | No enums in this table. Length CHECKs on `user_id`, `fact`, `embedding`, with a parity test. | Pass |
| Persistence: in-memory only in tests | `FakeMemoryStore` and `FakeEmbedder` live in `src/testing/`, never wired into `src/index.ts`. `AppSettings.memories` is required. | Pass |
| Persistence: no SQL outside the Model | Services and tools see only `MemoryStore`. | Pass |
| No stack change | `@huggingface/transformers` is added, nothing is replaced, so no amendment is needed. | Pass |
| Secrets | The model is public and needs no token. | Pass |

Post-design re-check: still all Pass.

## Project Structure

### Documentation (this feature)

```text
specs/008-semantic-memory/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── chat-api.md
│   ├── memory-store.md
│   └── memory-tools.md
├── checklists/requirements.md
└── tasks.md             # created by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── domain/
│   ├── errors.ts                     # + MemoryNotFoundError (DomainError), EmbeddingError
│   └── schemas.ts                    # + UserId, MemoryFact, MemoryId, Memory, RecalledMemory, RememberResult
├── memory/                           # NEW (paths from the request)
│   ├── embeddings.ts                 # Embedder, EMBEDDING_DIMENSIONS, dot, lazy singleton, localEmbedder
│   ├── embeddings.test.ts            # real model: unit length, single load, no-shared-word recall
│   ├── memory-store.ts               # MemoryStore, constants, pure helpers, MEMORY_SCHEMA, SqliteMemoryStore, openMemoryStore
│   ├── memory-store-contract.ts      # shared contract suite (not *.test.ts)
│   └── memory-store.test.ts          # contract on ":memory:", restart, CHECKs, pure helpers
├── agents/
│   ├── memories.ts                   # NEW: composeMemoryInput, withMemories
│   ├── memories.test.ts
│   ├── memory-tools.ts               # NEW: createMemoryTools(memories, userId)
│   └── memory-tools.test.ts
├── tools/
│   ├── definitions.ts                # + runToolTextAsync
│   └── memory-definitions.ts         # NEW: rememberFactDefinition, forgetFactDefinition
├── http/
│   ├── schemas.ts                    # userId; metrics.recalledMemories
│   ├── chat-reply.ts                 # ChatOutcome.recalledMemories in 200 and 502 metrics
│   ├── chat-service.ts               # memory tools → strategy → history → recall → create → run → save
│   ├── chat-controller.ts            # log EmbeddingError, re-throw to the 500 handler
│   ├── server.ts                     # AppSettings.memories (required)
│   └── *.test.ts                     # updated to pass FakeMemoryStore
├── testing/
│   ├── fake-embedder.ts              # NEW: table-driven unit vectors
│   ├── fake-memory-store.ts          # NEW
│   └── fake-memory-store.test.ts
└── index.ts                          # openMemoryStore({ embedder: localEmbedder })
```

**Structure Decision**: Single project. The memory code goes in a new `src/memory/` folder because
the request named `src/memory/embeddings.ts` and `src/memory/memory-store.ts`. The interface and
the SQLite class share `memory-store.ts` instead of splitting across `src/store/` as features 004
and 007 did. The fakes still go in `src/testing/`. The MCP server, arena, and bench are untouched.

## Implementation Notes

- **Order inside `runChat`** (research R9): `createDependencies()` plus `createMemoryTools` when
  `userId` → `createStrategy` (422 writes nothing) → `lastMessages` when `conversationId` (404) →
  `memories.recall(userId, message)` when `userId` → `create()` when no `conversationId` →
  `runWithTimeout(withHistory(withMemories(strategy, recalled), history).run)` → save the completed
  exchange → return the outcome with `recalledMemories: recalled.length`.
- **Dedup without a race**: in `remember`, await the embedding first, then scan and insert with no
  `await` between them (research R6).
- **BLOB decode**: copy the bytes before viewing them as `Float32Array` (research R5).
- **Singleton reset**: clear the cached pipeline promise when it rejects (research R2).
- **Learn-by-doing candidate**: `rankMemories` in `src/memory/memory-store.ts`. It holds the
  feature's decisions in a few lines: the `>=` against the minimum, best-first order, the newest-first
  tie-break by id, and the cut at the limit.
- **Docs**: README gains a short "Semantic memory" section (the `userId` field, the two tools, the
  first-run download, the offline skip flag). `CLAUDE.md` stays as it is: no new command.

## Complexity Tracking

No violations.
