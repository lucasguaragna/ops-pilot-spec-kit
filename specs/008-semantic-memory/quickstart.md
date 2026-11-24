# Quickstart: Semantic Memory

How to check that the feature works. Contracts: [memory-store.md](contracts/memory-store.md),
[memory-tools.md](contracts/memory-tools.md), [chat-api.md](contracts/chat-api.md).

## Prerequisites

- Node.js 22.13 or newer, `npm install` done (adds `@huggingface/transformers`).
- Network access once, for the 90 MB model download on first use. It is cached under
  `node_modules/@huggingface/transformers/.cache/`.
- For the end-to-end run: OpenRouter settings in your environment, as for `npm run dev` today.

## 1. Tests and types

```sh
npm run typecheck
npm test
```

Expected: both green. The first `npm test` waits a few seconds while `src/memory/embeddings.test.ts`
downloads and loads the model. That file proves SC-001: "who should I page about failed purchases?"
recalls "The payments team owns the checkout service" with no word in common.

Offline machine: `OPSPILOT_SKIP_MODEL_TESTS=1 npm test` skips only the real-model test and says so.

## 2. End to end

```sh
npm run dev
```

Save a fact (the agent should call `remember_fact`):

```sh
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Remember: the payments team owns the checkout service","reflect":false,"userId":"oncall-a"}'
```

New conversation, same user, no shared words:

```sh
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"who should I page about failed purchases?","reflect":false,"userId":"oncall-a"}'
```

Expected: `metrics.recalledMemories` is 1 and the answer names the payments team.

Same question as another user, or with no `userId`: `recalledMemories` is 0.

Forget it ("that fact about checkout ownership is outdated, forget it") as `oncall-a`, then ask
again: `recalledMemories` is 0.

## 3. Restart

Stop and start `npm run dev`, then repeat the second request. Expected: the fact is still recalled
(User Story 4).

## 4. Bad input

```sh
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"hi","reflect":false,"userId":"   "}'
```

Expected: `400`.
