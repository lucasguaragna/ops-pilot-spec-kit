# Quickstart: Model Fallback

## Prerequisites

- Node.js 22.13 or newer, `npm install` done.
- `.env` holds `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. For the live checks, also add
  `OPENROUTER_MODEL_FALLBACK=<another model id>`. Agents never read `.env`; you edit it.

## 1. Automated checks (no network)

```bash
npm run typecheck
npm test
```

They should pass, covering:

| Scenario | Where | Expected |
| --- | --- | --- |
| Settings: fallback empty, whitespace, or equal to the primary | `model.test.ts` | No fallback, no `ConfigurationError` |
| Primary fails, fallback answers | `resilient-model.test.ts` | Fallback answer, 1 switch, `modelUsed` = fallback |
| Primary fails once, then answers (`attempts: 2`) | `resilient-model.test.ts` | No switch, `count` = 2 |
| Non-retryable 400 | `resilient-model.test.ts` | 1 primary start, then the fallback |
| Aborted signal | `resilient-model.test.ts` | No fallback start, abort error propagates |
| Both fail | `resilient-model.test.ts` | `ModelUnavailableError` with `causeName` |
| Tools and schema reach the fallback | `resilient-model.test.ts` | Fallback receives the tool call request |
| `POST /chat`, primary down, fallback up | `server.test.ts` | 200, `fallback` event with `node`, `modelUsed` |
| `POST /chat`, both down | `server.test.ts` | 503 `model_unavailable`, partial trace and metrics |
| `POST /chat`, store fails | `server.test.ts` | Still 502 `run_failed` |
| Reply mapping | `chat-reply.test.ts` | `ModelUnavailableError` maps to 503, others to 502, timeout to 504 |

The contracts behind these are [contracts/chat-api.md](contracts/chat-api.md) and
[contracts/model-factory.md](contracts/model-factory.md).

## 2. Live check: the fallback answers

Set `OPENROUTER_MODEL` to an id that does not exist (for example `nope/missing-model`) and
`OPENROUTER_MODEL_FALLBACK` to a working model. Then:

```bash
npm run dev
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"List the critical alerts"}' | jq '{status: .stopReason, used: .metrics.modelUsed, switches: [.trace[] | select(.type=="fallback")]}'
```

Expected: `stopReason: "completed"`, `modelUsed` is the fallback, and one `fallback` event per
model call (router and react at least). Each has `error` with a class name (a 404 is not retried,
so the switch is immediate) and no provider text.

## 3. Live check: the 503

Set both settings to ids that do not exist and repeat the request with `curl -i`.

Expected: `HTTP/1.1 503`, `error: "model_unavailable"`, `runError.name` a class name, the
conversation id, and the partial trace. The server log shows one line for the failure, without the
API key.

## 4. Live check: unchanged when healthy

Restore a working `OPENROUTER_MODEL` and remove the fallback. Expected: a 200 with no `fallback`
event, `modelUsed` set to the primary, and the same `llmCalls` as before this feature.
