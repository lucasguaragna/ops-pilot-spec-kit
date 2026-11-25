# OpsPilot

OpsPilot is an on-call copilot for production alerts and incidents. On-call engineers can ask it
what is firing, which alert is oldest, or how a provider is doing. They can also have it open and
resolve incidents.

You can reach it in two ways:

- **HTTP chat API.** A LangChain/LangGraph agent running on OpenRouter reads the question,
  decides which tools to call, and answers in plain text.
- **MCP server.** Exposes the incident tools directly to an MCP client, such as Claude Code or
  VS Code. No model or API key is needed.

Both entry points read and write the same SQLite database, so an incident opened from one shows
up in the other right away.

The project is built while following a course on using AI agents inside VS Code. The course uses
GitHub Copilot; this repository uses Claude Code.

## How it works

```text
                 ┌──────────────────────────┐        ┌──────────────────────────┐
  curl, Insomnia │  HTTP  POST /chat        │        │  MCP over stdio          │ Claude Code,
  ──────────────▶│  src/http/               │        │  src/mcp/                │◀──── VS Code,
                 │  validate, timeout       │        │  3 tools, no model       │      Inspector
                 └────────────┬─────────────┘        └────────────┬─────────────┘
                              ▼                                   │
                 ┌──────────────────────────┐                     │
                 │  Strategy registry       │                     │
                 │  react | plan-execute    │                     │
                 │  (+ reflection critic)   │                     │
                 │  src/agents/  ◀─ LLM via OpenRouter            │
                 └────────────┬─────────────┘                     │
                              ▼                                   ▼
                 ┌────────────────────────────────────────────────────────────┐
                 │  Tool definitions: name, description, zod schema, run      │
                 │  src/tools/definitions.ts  (single source of truth)        │
                 └────────────┬───────────────────────────────┬───────────────┘
                              ▼                               ▼
                 ┌──────────────────────────┐   ┌──────────────────────────┐
                 │  OpsStore (SQLite)       │   │  Provider status         │
                 │  src/store/              │   │  GitHub, Cloudflare      │
                 │  OPSPILOT_DB             │   │  src/providers/          │
                 └──────────────────────────┘   └──────────────────────────┘
```

A chat request goes through these steps:

1. `POST /chat` validates the body with zod and picks a strategy by name.
2. The strategy calls the model. The model chooses tools, and their results go back to the
   model until it can answer. The tools come from the shared definitions.
3. With `reflect: true`, a critic checks the answer against what the tools returned. If the
   critic rejects the answer, the agent writes a new one.
4. The reply carries the answer, a trace of every step, the number of LLM calls, the latency, and
   a stop reason (`completed`, `iteration_limit` or `error`).

An MCP call skips the model. The client calls `list_alerts`, `open_incident` or `resolve_incident`
directly, and the server runs the same definition against the same store.

Domain errors such as an unknown service, an unknown incident or an incident that is already
resolved are classes in `src/domain/errors.ts`. Each entry point translates them into its own
error format. The agent and the MCP client get `Error: <message>`, and the HTTP API maps errors to
status codes.

## Features

Each feature has a folder in `specs/` with its spec, plan, tasks and contracts.

| Feature | What it adds | Spec |
| --- | --- | --- |
| Reasoning strategies | Two strategies behind one interface: `react` (tool loop) and `plan-execute` (plan, run each step, replan). Each run reports a trace, `llmCalls`, `latencyMs` and a stop reason | `001-reasoning-nucleus` |
| Reflection layer | `withReflection` wraps any strategy with a critic that checks the answer against the tool observations | `002-reflection-layer` |
| Chat endpoint | `POST /chat` runs a strategy with a 180 s timeout and cancels it when the time runs out | `003-chat-endpoint` |
| SQLite store | Alerts, incidents and runbooks in `node:sqlite`, with prepared statements and a seed | `004-sqlite-ops-store` |
| Provider status tool | `check_provider_status` reads the public GitHub or Cloudflare status page. It needs no key, retries once, times out after 5 s and never throws | `005-provider-status-tool` |
| MCP server | `opspilot` server over stdio that exposes the incident tools to MCP clients | `006-mcp-server` |
| Persistent conversation | `POST /chat` takes an optional `conversationId`. The newest 8 messages go into the prompt word for word, plus a summary of the older ones (see 011), saved in the same SQLite file | `007-persistent-conversation` |
| Semantic memory | `POST /chat` takes an optional `userId`. Up to 3 of that user's facts, matched by meaning with a local `all-MiniLM-L6-v2` model, go into the prompt; the agent saves and forgets facts with two tools | `008-semantic-memory` |
| Learning reflector | After each completed reply with a `userId`, a background step learns at most one lasting fact from the message, never a one-off request or a secret; `forget_preference` forgets a fact by description | `009-learning-reflector` |
| Context measurement | `metrics.promptTokens` is the real input token count the provider reported, and `metrics.contextBreakdown` estimates the starting context per source. `scripts/long-conversation.sh` prints both turn by turn | `010-context-measurement` |
| History summarization | Messages that leave the 8-message window are merged into one short telegraphic summary stored in `conversation_summaries`. It is refreshed only on batch boundaries, never on every request, and a `summarize` trace event marks the request that refreshed it | `011-history-summarization` |

### Tools

| Tool | What it does | Agent (HTTP) | MCP |
| --- | --- | :---: | :---: |
| `list_alerts` | List alerts by status: `firing` (default), `resolved` or `all`. Exact service names come from here | yes | yes |
| `open_incident` | Open an incident (`title`, `service`, `severity`: `low`, `medium`, `high` or `critical`) and return its `INC-NNN` id | yes | yes |
| `resolve_incident` | Resolve an incident by id, with an optional summary | yes | yes |
| `list_incidents` | List incidents by status | yes | no |
| `get_runbook` | Return the runbook of a service | yes | no |
| `check_provider_status` | Check the public status of GitHub or Cloudflare | yes | no |
| `remember_fact` | Save a lasting fact for the request's `userId`; a near-duplicate (score above 0.92) is not stored again | only with `userId` | no |
| `forget_fact` | Forget one of the request's user's facts by its `[memory N]` id | only with `userId` | no |

All tools are declared once in `src/tools/definitions.ts` (the memory tools in
`src/tools/memory-definitions.ts`, kept out of the MCP server), and their input schemas live in
`src/domain/schemas.ts`. The LangChain tools (`src/agents/tools.ts`) and the MCP tools
(`src/mcp/create-server.ts`) are both built from those definitions. Because of that, a change to a
description or a schema reaches the agent and the MCP clients in one edit.

## Requirements

- Node.js 22.13 or newer. It is the first 22.x where `node:sqlite` needs no flag.
- An OpenRouter API key, used only by the HTTP API, `arena` and `bench`. The MCP server needs no key.
- `jq`, used by the prompt hook.
- Claude Code.
- [Spec Kit CLI](https://github.com/github/spec-kit), only to update or re-initialize Spec Kit:
  `pipx install specify-cli`.

## Setup

```sh
npm ci
cp .env.example .env
```

Fill in `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in `.env`. Never commit `.env`.

| Variable | Used by | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | HTTP API, `arena`, `bench` | none (required for those) |
| `OPSPILOT_DB` | every entry point | `./data/opspilot.db` (`data/` is gitignored) |
| `PORT` | HTTP API | `3000` |
| `HOST` | HTTP API | `127.0.0.1` |
| `OPSPILOT_SKIP_MODEL_TESTS` | `npm test` | unset; `1` skips the one test that loads the real embedding model (for an offline machine) |

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the HTTP server (loads `.env`) |
| `npm run mcp` | Start the `opspilot` MCP server over stdio |
| `npm run arena` | Compare reasoning strategies on one request (`src/arena.ts`) |
| `npm run bench` | Score `react` and `plan-execute` on three scenarios (`src/bench.ts`) |
| `npm run seed` | Reset the database to the seed (deletes every incident) and print its counts |
| `npm test` | Run the tests |
| `npm run typecheck` | Type-check without emitting |

### Data

The app, `arena` and the MCP server all read and change the database at `OPSPILOT_DB`, so
incidents persist between runs. Opening the store only adds missing seed rows. `npm run seed` is
the destructive reset: it deletes every incident and restores the seeded records. Tests use
`:memory:` or temporary directories and never touch `data/`.

### arena

`arena` takes the request as text or through `--input`:

```sh
npm run arena -- "how many critical alerts are firing?" --strategies react
```

It has two other flags:

- `--strategies` (default `react,plan-execute`) picks from `react`, `plan-execute`,
  `reflect:react` and `reflect:plan-execute`. A `reflect:` strategy adds the critic.
- `--max-iterations` (default `10`).

The full contract is in
[specs/001-reasoning-nucleus/contracts/arena-cli.md](specs/001-reasoning-nucleus/contracts/arena-cli.md).

### bench

`bench` runs three scenarios with `react` and `plan-execute`:

- **C1:** count the critical alerts.
- **C2:** open three sev2 incidents in order and resolve the first.
- **C3:** open an incident for the oldest firing alert and say how many are left.

Each run gets a fresh in-memory store. A run is correct when the store state afterwards matches the
scenario, and for C1 and C3 also when the stated count is right. The output is one table with
`cenário`, `estratégia`, `acerto`, `llmCalls` and `latencyMs`.

Flags:

- `--scenario C1,C3` runs a subset.
- `--no-replanner` runs `plan-execute` without the replanner. The first plan runs as is, and one
  final call writes the answer.

## HTTP API

`npm run dev` starts the server on `PORT`. It listens on `127.0.0.1` only. Set `HOST` to change
that.

> **Warning:** The endpoint has no authentication, and `open_incident` and `resolve_incident`
> change data. Do not expose it to a network you do not trust.

Send `POST /chat` a JSON body, with the `content-type: application/json` header:

| Field | Type | Notes |
| --- | --- | --- |
| `message` | string | Required, not blank |
| `reflect` | boolean | Required; `true` adds the critic |
| `strategy` | string | Optional; `react` (default) or `plan-execute` |
| `conversationId` | string (UUID) | Optional; continues that conversation. Without it a new one starts |
| `userId` | string | Optional, 1 to 128 characters; recalls and saves that user's facts. Without it the run has no memory |

```sh
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Which alerts are firing?","reflect":false}'
```

| Status | `error` | When |
| --- | --- | --- |
| 200 | none | The run finished: `{conversationId, answer, stopReason, trace, metrics}`. `answer` is `null` at the iteration limit |
| 400 | `invalid_body` | The body fails validation or is not JSON; `issues` lists the zod problems |
| 404 | `conversation_not_found` | `conversationId` is a UUID but names no conversation. The agent does not run |
| 422 | `unknown_strategy` | Unknown `strategy`; `knownStrategies` lists the valid names |
| 500 | `internal` | An unexpected error, including a memory recall that failed (the server logs `Memory recall failed: …`) |
| 502 | `run_failed` | The run returned an error or threw. The message is fixed; the real error is in the server log |
| 504 | `timeout` | The run did not finish in 180 s and was cancelled |

Every reply names its conversation in `conversationId`, and `metrics.historyMessages` says how many
earlier messages the agent was given word for word (8 to 14; a summary stands for the older ones). To continue a conversation, send that id back:

```sh
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Open an incident for the worst one","reflect":false,"conversationId":"<id>"}'
```

Only a run that finishes with an answer is saved, so a failed or timed-out request leaves the
history as it was and can be retried. Conversations live in the file at `OPSPILOT_DB` and survive a
restart. The 502 and 504 replies also carry `conversationId`.

### Semantic memory

With a `userId`, the server recalls that user's facts before the run: up to 3, best first, each
scoring at least 0.3 against the message by meaning, not by shared words. They go ahead of the
message as `[memory N] <fact>` lines, and `metrics.recalledMemories` says how many. The agent also
gets `remember_fact` and `forget_fact`, bound to that `userId`, so it can only touch that user's
facts. Facts live in the `memories` table of the file at `OPSPILOT_DB`.

```sh
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Remember: the payments team owns the checkout service","reflect":false,"userId":"oncall-a"}'
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"who should I page about failed purchases?","reflect":false,"userId":"oncall-a"}'
```

The second request shares no word with the fact, and still recalls it. Embeddings come from
`Xenova/all-MiniLM-L6-v2` through `@huggingface/transformers`, run locally. The model (about 90 MB)
is downloaded on the first request that needs it and cached under
`node_modules/@huggingface/transformers/.cache/`; after that it runs offline.

**Learning.** The engineer does not have to say "remember". After a request with a `userId`
completes with an answer, a background step reads only that request's message and asks the same
model whether it states a lasting fact (who owns what, the engineer's team, preferences, quirks of
their systems). It keeps at most one fact per message and saves it through the same memory, so
the 0.92 dedup applies. It never learns one-off requests, questions, or the state of a live alert,
and never a secret: besides the prompt rule, every proposed fact goes through a deterministic
check for passwords, keys, tokens, and credentialed URLs. The reply never waits for the step, its
model calls are not counted in `metrics.llmCalls`, and it gives up after 30 s. The outcome only
reaches the server log, as `Learned [memory N] for <userId>`, or `Learning skipped for <userId>:
secret` (the fact itself is never logged). A third tool, `forget_preference`, removes the single
closest fact to a short description, and only when it scores at least 0.5, so the engineer can
say "forget that I like bullet lists" without knowing the `[memory N]` id.

### History summarization

The agent reads a conversation in three layers: your remembered facts, then one summary of the older
messages, then the messages the summary does not cover word for word, then the request.

- **Window.** The newest 8 messages are always word for word. Older messages not yet summarized stay
  word for word too, so the agent sees 8 to 14.
- **When.** One summarization runs once 8 messages have left the window: on exchanges 9, 13, 17, and
  so on. It never runs on every request, and it runs inside that `POST /chat`, before the agent, under
  its own 30 s limit.
- **What.** One model call merges the previous summary with the messages that left the window into
  one short text of telegraphic bullets (decisions, facts, incidents, open items), asked to stay under
  150 tokens. The code caps it at 300 estimated tokens, dropping whole lines from the end, and drops any
  line that looks like a credential before it is stored.
- **Where.** `conversation_summaries`, one row per conversation in the same SQLite file. It survives a
  restart, and the next request makes no summarization call.
- **See it.** The reply of the request that refreshed the summary starts its `trace` with
  `{ "type": "summarize", "content": "<the summary>", "absorbed": 8 }`. No other reply has one. The
  summarizer's calls and tokens are counted in `metrics`.
- **Failure.** A failed summarization (provider error, timeout, nothing usable) never changes the
  status code, the answer, or the trace. The agent gets the previous summary and the newest 14 messages,
  the server logs one line without the summary text, and the next attempt waits for the next batch
  boundary. Each attempt makes exactly one model call.

### Context measurement

A 200 reply, and a `run_failed` 502 that carries metrics, say how big the prompt was:

| Field | Meaning |
| --- | --- |
| `metrics.promptTokens` | **Real.** The input tokens the provider reported, summed over every model call of the run: planner, each ReAct step, retries, critic, rewrite. `null` when no call reported usage. The learning step is not included |
| `metrics.contextBreakdown` | **Estimated.** `system`, `tools`, `history`, `memories`, and `message`, each as characters divided by 4 rounded up, and `total`, their sum. It describes the context the agent *starts* with, after the history window (8 to 14 messages plus the summary) and the 3-fact limit |

The estimate counts string length, so accents count 1 and an emoji counts 2; it is a teaching
baseline, not a tokenizer. Tool observations join the context during a run, so they show up in
`promptTokens` but not in the breakdown. `promptTokens` also adds up every call, so compare the two
only on a reply with `llmCalls: 1`.

`scripts/long-conversation.sh` sends a fixed series of messages in one conversation to a running
server and prints one line per turn. It needs `curl` and `jq`:

```sh
scripts/long-conversation.sh
OPSPILOT_URL=http://127.0.0.1:3001 TURNS=14 scripts/long-conversation.sh
```

Example output:

```text
turn 8 | promptTokens 2398 | history 531 (14 messages)
turn 9 | promptTokens 2210 | history 480 (8 messages)
turn 10 | promptTokens 2395 | history 526 (10 messages)
```

`OPSPILOT_URL` defaults to `http://127.0.0.1:3000` and `TURNS` to 10. A failed turn prints
`turn N | error <code>` and the run goes on; an unreachable server prints `Cannot reach <url>` and
exits 1. The `(k messages)` count climbs to 14 and drops to 8 on turn 9, when the history is summarized.

The server validates every reply body against its schema before sending it.

More material on the API:

- **OpenAPI:** [docs/openapi.yaml](docs/openapi.yaml) explains each field and has an example for
  every status. You can open it in the Swagger Editor (<https://editor.swagger.io>) or in a VS Code
  OpenAPI viewer.
- **Insomnia:** import [docs/insomnia.json](docs/insomnia.json) from the Application menu, then
  Import. It has one request per case above and a `base_url` environment variable.
- **Contract:** the full shapes are in
  [specs/003-chat-endpoint/contracts/chat-http.md](specs/003-chat-endpoint/contracts/chat-http.md).

## MCP server

`npm run mcp` starts an MCP server named `opspilot`. It speaks newline-delimited JSON-RPC 2.0 over
stdio and exposes `list_alerts`, `open_incident` and `resolve_incident`.

The MCP client is the one doing the reasoning, so the server needs no model and no API key.

### Connect a client

The repository already registers the server for two clients:

| Client | File | What to do |
| --- | --- | --- |
| Claude Code | `.mcp.json` | Start Claude Code in the repository root, approve the `opspilot` project server, then run `/mcp`: it shows `opspilot` with 3 tools |
| VS Code | `.vscode/mcp.json` | Open the folder in VS Code and start `opspilot` from the MCP servers list |

Both files run `npm run --silent mcp`. The `--silent` flag stops npm from printing its banner to
stdout, which would corrupt the protocol stream.

After connecting, you can ask in plain language. For example, "what alerts are firing?" makes the
client call `list_alerts`. "open a low incident for notification-service" makes it call
`list_alerts` to find the exact service name and then `open_incident`.

To inspect the server by hand, use the MCP Inspector:

```sh
OPSPILOT_DB=":memory:" npx @modelcontextprotocol/inspector npm run --silent mcp
```

### Behaviour

| Situation | Result |
| --- | --- |
| Success | Text content with the JSON the store returned, the same text the agent tool returns |
| Domain error (unknown service or incident, already resolved) | `isError: true` with `Error: <message>` |
| Arguments that break the schema | Rejected by the SDK before the handler runs; the store is not changed |
| Unexpected failure | `isError: true` with `Error: internal error`; the details go to stderr |
| Store cannot be opened | The reason goes to stderr, nothing goes to stdout, and the process exits with code 1 |
| stdin closed, `SIGINT`, `SIGTERM` | Closes the server and the store, then exits with code 0 |

The server keeps running after every tool error.

**stdout carries protocol messages only.** No code in `src/mcp/` may write to stdout. The rule is
enforced in three ways:

- `src/mcp/stdout-guard.ts` redirects `console.log`, `console.info` and `console.debug` to stderr.
  It is the first import of `server.ts`, because ES imports run before the module body.
- A test fails if `console.log` or `process.stdout.write` appears in `src/mcp/`.
- Another test checks that every stdout line of a real session is JSON-RPC.

Diagnostics go to stderr, for example `opspilot: ready (db: <path>)` and
`opspilot: shutting down`.

The full contract is in
[specs/006-mcp-server/contracts/mcp-server.md](specs/006-mcp-server/contracts/mcp-server.md). The
validation steps are in [specs/006-mcp-server/quickstart.md](specs/006-mcp-server/quickstart.md).

## Project layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | HTTP entry point: opens the store, builds the model and tools, starts Express |
| `src/http/` | Express app, `POST /chat` controller, service, schemas and reply mapper |
| `src/mcp/` | MCP entry point (`server.ts`), server factory (`create-server.ts`) and stdout guard |
| `src/agents/` | Strategies (`react`, `plan-and-execute`), reflection, model, LangChain tools and the strategy registry |
| `src/tools/` | Shared tool definitions used by both the agent and the MCP server |
| `src/providers/` | Client for the public GitHub and Cloudflare status pages |
| `src/store/` | `OpsStore` interface, SQLite and in-memory stores, seed data and the `seed` script |
| `src/domain/` | Types, zod schemas and domain errors |
| `src/trace/` | Builds and formats the run trace from the agent messages |
| `src/testing/` | Scripted chat model so tests run without a real LLM |
| `src/arena.ts`, `src/bench.ts` | Strategy comparison and scoring CLIs |
| `specs/` | One folder per feature: spec, plan, research, data model, contracts, quickstart and tasks |
| `docs/` | OpenAPI file, Insomnia collection, reference code samples (`code-examples/`) and the prompt log (`prompts/`) |
| `.mcp.json`, `.vscode/mcp.json` | MCP server registration for Claude Code and VS Code |
| `CLAUDE.md` | Instructions for Claude Code |
| `.claude/` | Permissions, the prompt hook and Spec Kit skills |
| `.specify/` | Constitution, templates and scripts |

## Conventions

- All external input is validated with zod at the boundary (HTTP, CLI, MCP).
- Domain errors are classes and are translated at the edge.
- Every SQLite query uses a prepared statement.
- New logic ships with a test. `npm run typecheck` and `npm test` stay green.
- Secrets are never committed, and `.env` is never read by the agents.

## Workflow

Features follow the Spec Kit flow, and the specs are versioned in the repository:

`/speckit-specify` -> `/speckit-plan` -> `/speckit-tasks` -> `/speckit-implement`

## Boilerplate

The Git tag `boilerplate-v1` marks a reusable starting point. At that commit the project has
tooling and agent setup but no feature code: `src/index.ts` is empty and `specs/` does not exist.
Reuse that tag, not `main`, which moves on as the course adds features.

It includes:

- TypeScript ESM with `strict: true`, plus `dev`, `arena`, `bench`, `test` and `typecheck` scripts
- Spec Kit skills and templates for Claude Code
- Project instructions, constitution and tool permissions
- A hook that records every prompt in `docs/prompts/`

To start a new project from it:

```sh
git clone --branch boilerplate-v1 --depth 1 <repository> my-project
cd my-project
rm -rf .git docs/prompts/0*.md
git init
npm ci
```

Then adapt these files:

- `package.json`: project name and dependencies
- `CLAUDE.md`: description, stack and conventions
- `.specify/memory/constitution.md`: principles and stack
- `README.md`: this content
- `.env.example`: variables the new project needs

## Replicating this project

`docs/prompts/` holds every step used to build the project, in order. See its
[README](docs/prompts/README.md).
