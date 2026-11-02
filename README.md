# OpsPilot

OpsPilot is an on-call copilot that manages production alerts and incidents. Its API is a
LangChain/LangGraph agent running on OpenRouter. It is built while following a course on using AI
agents inside VS Code, with Claude Code instead of GitHub Copilot.

## Features

- **Reasoning strategies.** `react` (tool loop) and `plan-execute` (plan, run each step, replan)
  share one interface and report a trace, `llmCalls`, `latencyMs`, and a stop reason
  (`completed`, `iteration_limit`, or `error`). Spec: `specs/001-reasoning-nucleus`.
- **Reflection layer.** `withReflection` wraps any strategy with a critic that checks the answer
  against the tool observations and regenerates it when rejected. Spec: `specs/002-reflection-layer`.
- **Tools.** `list_alerts`, `open_incident`, and `resolve_incident`, backed by a store that is
  in memory in tests and a JSON file (`data/db.json`) at runtime.
- **Strategy registry.** `src/agents/index.ts` maps a name to a strategy and applies reflection on
  request. The HTTP endpoint and the arena both use it.
- **Arena and bench.** `arena` compares strategies on one request; `bench` scores them on three
  scenarios.
- **HTTP endpoint.** `POST /chat` runs a strategy under a timeout and cancels it when the time is up.
  Spec: `specs/003-chat-endpoint`. See [HTTP API](#http-api).

## HTTP API

`npm run dev` starts the server on `PORT` (default `3000`). It listens on `127.0.0.1` only; set
`HOST` to change that. The endpoint has no authentication and `open_incident` and `resolve_incident`
change data, so do not expose it to a network you do not trust.

`POST /chat` with a JSON body (send the `content-type: application/json` header):

| Field | Type | Notes |
| --- | --- | --- |
| `message` | string | Required, not blank |
| `reflect` | boolean | Required; `true` adds the critic |
| `strategy` | string | Optional; `react` (default) or `plan-execute` |

```sh
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Which alerts are firing?","reflect":false}'
```

| Status | `error` | When |
| --- | --- | --- |
| 200 | none | Run finished: `{answer, stopReason, trace, metrics}`. `answer` is `null` at the iteration limit |
| 400 | `invalid_body` | Body fails validation or is not JSON; `issues` lists the zod problems |
| 422 | `unknown_strategy` | Unknown `strategy`; `knownStrategies` lists the valid names |
| 502 | `run_failed` | The run returned an error or threw. The message is fixed and the real error is in the server log |
| 504 | `timeout` | The run did not finish in 180 s; it is cancelled |

Every reply body is validated against its schema before it is sent. Full shapes are in
[specs/003-chat-endpoint/contracts/chat-http.md](specs/003-chat-endpoint/contracts/chat-http.md).

## Boilerplate

The Git tag `boilerplate-v1` marks a reusable starting point. At that commit the project has
tooling and agent setup but no feature code: `src/index.ts` is empty and `specs/` does not exist.
Reuse that tag, not `main`, which moves on as the course adds features.

It includes:

- TypeScript ESM with `strict: true`, plus `dev`, `arena`, `bench`, `test`, and `typecheck` scripts
- Spec Kit skills and templates for Claude Code
- Project instructions, constitution, and tool permissions
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
- `CLAUDE.md`: description, stack, and conventions
- `.specify/memory/constitution.md`: principles and stack
- `README.md`: this content
- `.env.example`: variables the new project needs

## Requirements

- Node.js 22.9 or newer (22 LTS is the baseline)
- `jq`, used by the prompt hook
- Claude Code
- [Spec Kit CLI](https://github.com/github/spec-kit), only to update or re-initialize Spec Kit:
  `pipx install specify-cli`

## Setup

```sh
npm ci
cp .env.example .env
```

Fill in `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in `.env`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the HTTP server (loads `.env`) |
| `npm run arena` | Compare reasoning strategies on one request (`src/arena.ts`) |
| `npm run seed` | Write the seed to `data/db.json` and print its counts |
| `npm run bench` | Score `react` and `plan-execute` on three scenarios (`src/bench.ts`) |
| `npm test` | Run the tests |
| `npm run typecheck` | Type-check without emitting |

`arena` loads `.env` through Node's native `--env-file-if-exists` flag. It takes the request as
text (`npm run arena -- "how many critical alerts are firing?" --strategies react`) or with
`--input`. Its other flags are `--strategies` (default `react,plan-execute`) and `--max-iterations`
(default `10`). The strategies are `react`, `plan-execute`, `reflect:react`, and
`reflect:plan-execute`; a `reflect:` strategy adds a critic that checks the answer against the tool
observations and regenerates it when rejected (`npm run arena -- "..." --strategies react,reflect:react`);
see [specs/001-reasoning-nucleus/contracts/arena-cli.md](specs/001-reasoning-nucleus/contracts/arena-cli.md).
`arena` reads and changes `data/db.json`, so incidents persist between runs; `npm run seed` resets
it. Tests use memory and never touch the file.

`bench` runs scenarios C1 (count critical alerts), C2 (open three sev2 incidents in order and
resolve the first), and C3 (open an incident for the oldest firing alert and say how many are left)
with `react` and `plan-execute`. Each run gets a fresh in-memory store, and a run is correct when the
store state afterwards matches the scenario (plus the stated count for C1 and C3). It prints one
table with `cenário`, `estratégia`, `acerto`, `llmCalls`, and `latencyMs`. Flags: `--scenario C1,C3`
runs a subset, and `--no-replanner` runs `plan-execute` without the replanner: the first plan runs as
is and one final call writes the answer.

## Workflow

Features follow the Spec Kit flow, with specs versioned in the repository:

`/speckit-specify` -> `/speckit-plan` -> `/speckit-tasks` -> `/speckit-implement`

## Project layout

| Path | Purpose |
| --- | --- |
| `CLAUDE.md` | Instructions for Claude Code |
| `.claude/` | Permissions, prompt hook, and Spec Kit skills |
| `.specify/` | Constitution, templates, and scripts |
| `docs/prompts/` | Every prompt sent, in order |
| `src/agents/` | Strategies, reflection, tools, model, and the strategy registry |
| `src/http/` | Express app, `POST /chat` controller, service, and reply mapper |
| `src/store/` | In-memory and JSON file stores, and the seed |
| `src/domain/` | Types, schemas, and domain errors |
| `specs/` | One folder per feature: spec, plan, tasks, and contracts |

## Replicating this project

`docs/prompts/` holds the steps used to build the project. See its
[README](docs/prompts/README.md).
