# Quickstart: Learning Reflector

How to check that the feature works. Contracts: [learning-reflector](contracts/learning-reflector.md),
[memory-store](contracts/memory-store.md), [memory-tools](contracts/memory-tools.md).

## Prerequisites

- Node.js 22.13 or newer, `npm install` done.
- The embedding model was downloaded once (feature 008); otherwise the first request takes a few
  seconds longer.
- For the manual part only: an OpenRouter key in your own `.env`, and a scratch database so your
  real data stays untouched, for example `OPSPILOT_DB=/tmp/opspilot-009.db`.

## Automated checks

```bash
npm run typecheck
npm test
```

Expected: both green. The new tests cover:

| Spec | Where |
| --- | --- |
| US1, FR-001, FR-006, SC-001 | `learning-reflector.test.ts` (saved, duplicate); `chat-service.test.ts` (learned fact recalled in a new conversation) |
| US2, FR-004, FR-005, SC-002 | `learning-reflector.test.ts` (`looksLikeSecret` cases, every `factToSave` reason, a model that proposes a secret) |
| FR-002 | `chat-reply.test.ts` (`shouldLearn`); `chat-service.test.ts` (no userId, iteration limit, error, timeout: no step) |
| FR-007, SC-003, SC-006 | `chat-service.test.ts` (gated store: reply returned while the step is pending; reply and metrics identical) |
| FR-008, SC-004 | `chat-service.test.ts` (model failure and timeout: logged, reply unchanged) |
| US3, FR-010 to FR-012, SC-005 | `memory-store-contract.ts` (`forgetClosest`, 0.5 boundary, tie, per user); `memory-tools.test.ts` |
| FR-013 | existing `remember_fact` and `forget_fact` tests, unchanged |

## Manual check (live model)

Start the server against the scratch database:

```bash
OPSPILOT_DB=/tmp/opspilot-009.db npm run dev
```

1. **Learn without being asked.** Send:

   ```bash
   curl -s localhost:3000/chat -H 'content-type: application/json' \
     -d '{"message":"I am on the payments team, so checkout alerts are mine. Which alerts are firing?","userId":"oncall-a"}'
   ```

   Expected: a normal reply with the same shape as before. Shortly after, the server log shows
   `Learned [memory <id>] for oncall-a`.

2. **Recall it later.** Send, with no `conversationId`:

   ```bash
   curl -s localhost:3000/chat -H 'content-type: application/json' \
     -d '{"message":"Which alerts should I look at first?","userId":"oncall-a"}'
   ```

   Expected: `metrics.recalledMemories` is at least 1 and the answer favours checkout.

3. **Never learn a one-off request.** Send `"Open an incident for checkout"` with the same
   `userId`. Expected: no `Learned` line.

4. **Never learn a secret.** Send `"The staging DB password is hunter2"` with the same `userId`.
   Expected: no `Learned` line; at most `Learning skipped for oncall-a: secret`. The password
   never appears in the log.

5. **Forget by description.** Send `"Forget that I am on the payments team"`. Expected: the trace
   shows a `forget_preference` call returning `forgotten: true` with the fact; repeating step 2
   recalls nothing about payments.

6. **No user, no learning.** Repeat step 1 without `userId`. Expected: no `Learned` line, and no
   memory tools in the trace.

Remove the scratch database afterwards: `rm /tmp/opspilot-009.db`.
