# Quickstart: Unified Graph

## Prerequisites

- Node.js 22.13 or newer, with `npm install` done.
- `curl` and `jq` for the manual scenarios.
- For the manual scenarios only: an OpenRouter key and model in `.env`, which only the app reads.

## 1. Automated checks

```sh
npm run typecheck
npm test
```

Both must be green. The new tests cover:

- `requestedRoute`, `decideRoute`, `routeOf`, and the routing table holding every route
  ([contracts/production-graph.md](contracts/production-graph.md)).
- `tagNode` and `finalizeTrace`: the final answer moves to `response`, and `reflect` drafts and
  iteration-limit traces stay with the strategy.
- The router with a scripted model: a valid answer, `parsed: null`, an invalid route, a thrown
  error (fallback), and an abort (rethrown).
- The graph with a scripted model, once per route, plus an override (no router call), a fallback, a
  stored summarization (`summarize` first, `node: "context"`), and a strategy error.
- `POST /chat`: an optional `strategy`, the `reflect` alias, the `400` conflict, the unchanged
  `422`, and `node` on every event ([contracts/chat-api.md](contracts/chat-api.md)).

## 2. Manual: the router decides

```sh
npm run dev
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Which alerts are firing?"}' | jq '.trace | map({node, type, route, source})'
```

Expected: `context` (only on a summarization), then one `router`/`route` event with
`source: "router"`, then the strategy's events, then `response`/`answer`. A quick lookup usually
routes to `react`.

```sh
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Open an incident for each critical firing alert, then tell me how many are left"}' \
  | jq '.trace[] | select(.type == "route")'
```

Expected: usually `route: "plan-execute"`, with a reason. This writes data; run `npm run seed` to
reset.

## 3. Manual: override and alias

```sh
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Which alerts are firing?","strategy":"plan-execute"}' \
  | jq '{route: (.trace[] | select(.type == "route")), llmCalls: .metrics.llmCalls}'
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Which alerts are firing?","reflect":true}' | jq '.trace[] | select(.type == "route")'
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"hi","strategy":"react","reflect":true}'
```

Expected: `source: "override"` and `route: "plan-execute"`, with no router call counted. Then
`route: "reflect"`, `source: "override"`. Then `400`.

## 4. Existing tools

- `npm run arena` and `npm run bench` work as before. They run strategies directly, so their
  events print with no node.
- `scripts/long-conversation.sh` sends `strategy: "react"`, so it runs as an override and its
  output is unchanged apart from the new trace fields.
- `docs/insomnia.json` must be updated. "react + reflection" and "plan-execute + reflection" become
  `reflect: true` alone (the second one loses plan-and-execute). "400 - missing reflect" becomes a
  `400` for the conflict. A new request with only `message` shows the router.
