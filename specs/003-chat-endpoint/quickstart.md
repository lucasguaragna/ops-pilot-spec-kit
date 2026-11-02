# Quickstart: Chat Endpoint

## Prerequisites

- `npm install` done; `data/db.json` seeded with `npm run seed`
- `OPENROUTER_API_KEY` in `.env` only for the manual run below; the tests need no key and no
  network

## 1. Automated checks

```bash
npm run typecheck
npm test
```

Expected: both pass. `src/http/server.test.ts` covers 200 (completed and iteration limit), 400
(missing `reflect`, empty message, bad JSON), 422, 502 (error result and throw), 504 with the fake
strategy's signal aborted, reflection on and off, and 404 for another path. It finishes in under
5 seconds.

## 2. Manual run

```bash
npm run dev                # listens on PORT, default 3000
```

| Request | Expected |
| --- | --- |
| `curl -s localhost:3000/chat -H 'content-type: application/json' -d '{"message":"Which alerts are firing?","reflect":false}'` | 200, `stopReason` `completed`, trace with `list_alerts` |
| Same with `"strategy":"plan-execute","reflect":true` | 200, trace has `plan` and `critique` events |
| `-d '{"message":"hi"}'` | 400, issue on `reflect` |
| `-d '{"message":"hi","reflect":false,"strategy":"React"}'` | 422, known names listed |
| `-d 'not json'` | 400, `invalid_body` |

Reply shapes are in [contracts/chat-http.md](contracts/chat-http.md).

## 3. Arena still works

```bash
npm run arena -- --strategies react,reflect:react "Which alerts are firing?"
```

Expected: both strategies run from the shared registry, as before.
