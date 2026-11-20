---

description: "Task list for the Provider Status Tool feature"
---

# Tasks: Provider Status Tool

**Input**: Design documents from `specs/005-provider-status-tool/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/check-provider-status.md](contracts/check-provider-status.md),
[quickstart.md](quickstart.md)

**Tests**: Requested. FR-010 asks for tests with a fake fetch and no network, and the constitution
says new logic ships with a test. Within each story, the test task comes first and must fail before
the implementation task.

**Organization**: Tasks are grouped by user story, so each story can be built and checked on its
own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1 to US3)
- Every description names the exact file path

## Path Conventions

Single project. Source in `src/`, tests next to the code as `*.test.ts`, run with `node:test`
through `tsx`. Gates: `npm run typecheck` and `npm test`. No test may use the network (FR-010).

---

## Phase 1: Setup

**Purpose**: Confirm a green baseline. No new dependency is added (plan, Stack row).

- [X] T001 Run `npm run typecheck` and `npm test` from the repository root and confirm both pass
  before any change, so later failures belong to this feature.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: The input schema and the module's types and constants. Every story depends on this
phase.

**⚠️ CRITICAL**: No user story work starts until this phase is done and `npm run typecheck` is
green.

- [X] T002 In `src/domain/schemas.ts`, add
  `Provider = z.enum(["github", "cloudflare"])` with its type, and
  `CheckProviderStatusInput = z.object({ provider: Provider.default("github").describe(...) })`.
  The describe text names both values and says the default is `github` (FR-002, contract Input
  row). Keep the wording short; US3 (T013) refines it.
- [X] T003 Create `src/providers/provider-status.ts` with the types and constants only
  ([data-model.md](data-model.md), [contract](contracts/check-provider-status.md#module)):
  - `STATUS_URLS: Record<Provider, string>` with `github` to
    `https://www.githubstatus.com/api/v2/status.json` and `cloudflare` to
    `https://www.cloudflarestatus.com/api/v2/status.json` (typed as a `Record`, so a provider
    without a URL fails type-checking);
  - `StatusPageBody = z.object({ status: z.object({ indicator: z.string().trim().min(1), description: z.string().trim().min(1) }) })`
    ("Extra fields are stripped"; "The indicator is not an enum", R7);
  - `type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>` (R6);
  - `type ProviderStatus = { provider: Provider; indicator: string; description: string }`;
  - `type Failure = { kind: "timeout" } | { kind: "network" } | { kind: "http"; status: number } | { kind: "invalid" }`;
  - `type CheckResult = { ok: true; status: ProviderStatus } | { ok: false; failure: Failure; attempts: 1 | 2 }`;
  - `type CheckDeps = { fetch?: FetchLike; timeoutMs?: number }` (defaults: global `fetch`, `5000`).

**Checkpoint**: `npm run typecheck` green.

---

## Phase 3: User Story 1 - "Is it ours or the provider's?" (Priority: P1) 🎯 MVP

**Goal**: The tool fetches the right status page and returns one line
`<provider>: <indicator> - <description>`.

**Independent Test**: With a fake fetch returning 200 and
`{ status: { indicator: "minor", description: "Partial System Outage" } }`, calling the tool for
`github` returns `github: minor - Partial System Outage`, and the fake saw the GitHub URL.

### Tests for User Story 1

- [X] T004 [P] [US1] Create `src/providers/provider-status.test.ts` (fails until T005) with:
  - `classifyResponse(200, body)` with a valid body returns the `ok` outcome with trimmed fields;
    extra fields in the body are dropped;
  - `formatStatusLine` returns `github: none - All Systems Operational`; collapses whitespace runs
    and line breaks in the description to one space; cuts a line longer than 200 characters to
    200 characters ending in `…` (R5, SC-004);
  - `checkProviderStatus("github", { fetch: fake })` succeeds with one call to
    `STATUS_URLS.github`; `"cloudflare"` with `minor` / "Minor Service Outage" calls only
    `STATUS_URLS.cloudflare` (US1 scenarios 1 and 2);
  - an unknown non-empty indicator such as `maintenance` passes through (edge case).
  The fake fetch is a small function that records `url` and returns
  `new Response(JSON.stringify(body), { status })`.
- [X] T005 [P] [US1] In `src/agents/tools.test.ts` (fails until T007):
  - update "are named as in the contract" to the six names in contract order, ending with
    `check_provider_status`;
  - add a `describe("check_provider_status")` block that builds tools with
    `createTools(new SqliteOpsStore(":memory:"), { fetch: fake })` and checks: called with `{}` it
    requests `STATUS_URLS.github` and returns the formatted line (US1 scenario 3); called with
    `{ provider: "aws" }` it is rejected and the fake was never called (US1 scenario 4).

### Implementation for User Story 1

- [X] T006 [US1] In `src/providers/provider-status.ts`, implement the success path:
  - `classifyResponse(status: number, body: unknown)`: for a 2xx, `StatusPageBody.safeParse(body)`;
    success gives the `ok` outcome with `indicator` and `description`. Non-2xx and parse failure
    branches can return a placeholder `invalid` for now (US2 fills them in);
  - `formatStatusLine(status: ProviderStatus)`: `<provider>: <indicator> - <description>`,
    description whitespace collapsed with `/\s+/g` to `" "`, total capped at 200 characters with
    `…` (R5);
  - `checkProviderStatus(provider, deps = {})`: one attempt with
    `fetch(STATUS_URLS[provider], { signal: AbortSignal.timeout(timeoutMs) })`, read the body with
    `response.json()` (a JSON parse error counts as an invalid body), pass it to
    `classifyResponse`, and return a `CheckResult`. All pure functions stay free of I/O.
  Makes T004 pass.
- [X] T007 [US1] In `src/agents/tools.ts`:
  - change the signature to `createTools(store: OpsStore, deps: CheckDeps = {})`;
  - append `check_provider_status` as the sixth entry, with schema `CheckProviderStatusInput`.
    The handler calls `checkProviderStatus(provider, deps)` and returns `formatStatusLine(...)`
    on `ok`. It does NOT use `toToolText`, which re-throws non-domain errors (R4);
  - use a one-sentence placeholder description (US3 writes the full one).
  The six existing `createTools(store)` call sites stay unchanged. Makes T005 pass.

**Checkpoint**: `npm run typecheck` and `npm test` green. US1 works on the happy path.

---

## Phase 4: User Story 2 - A broken status page never breaks the run (Priority: P1)

**Goal**: Timeouts, network errors, and 5xx get exactly one retry; 4xx and invalid bodies are
final; every failure is an `Error: ...` line; nothing throws.

**Independent Test**: With fakes that never answer (`timeoutMs: 20`), that return 503 twice, or
that return HTML with status 200, the tool returns an `Error: ...` text, the call count matches the
retry table, and no exception escapes.

### Tests for User Story 2

- [X] T008 [P] [US2] In `src/providers/provider-status.test.ts`, add pure-function tests (fail
  until T010):
  - `classifyResponse`: 503 gives `{ kind: "http", status: 503 }`; 404 and 429 give `http` with
    their code; 200 with a body missing `description`, with an empty `indicator`, or with a
    non-object gives `invalid` (R2 rows);
  - `classifyError`: an error named `TimeoutError` gives `timeout`; one named `AbortError` gives
    `timeout`; a `TypeError("fetch failed")` and a non-Error value give `network` (R3);
  - `isRetryable`: `true` for `timeout`, `network`, `http` 500 and 503; `false` for `http` 404,
    `http` 429, and `invalid`;
  - `formatFailure(provider, failure, attempts)`: one test per row of the contract's failure
    details table (`timed out after 2 attempts`, `network error after 2 attempts`,
    `HTTP 503 after 2 attempts`, `HTTP 404`, `invalid response`), each starting with
    `Error: github status check failed (` and ending with
    `Answer from internal alerts and tell the engineer the provider status is unknown.`, on one
    line.
- [X] T009 [US2] In `src/providers/provider-status.test.ts`, add loop tests with a counting
  fake fetch (fail until T011):
  - timeout through the real signal: `timeoutMs: 20` and a fake that returns a promise rejected
    only when `init.signal` fires (`signal.addEventListener("abort", () => reject(signal.reason))`);
    two calls, failure `timeout`, `attempts: 2` (R3, US2 scenario 1);
  - 503 then 200: two calls, success (US2 scenario 2);
  - 503 twice: two calls, failure `http` 503, `attempts: 2` (US2 scenario 3);
  - 404: one call, failure `http` 404, `attempts: 1` (US2 scenario 4);
  - 200 with an HTML body, and 200 with `{ status: {} }`: one call each, failure `invalid`
    (US2 scenario 5, edge case);
  - network error then 200: two calls, success;
  - a fake that throws synchronously: returns a failure, `assert.doesNotReject` on the call
    (edge case, R4).
- [X] T010 [P] [US2] In `src/agents/tools.test.ts`, inside `describe("check_provider_status")`,
  add: with a fake that always rejects, the tool resolves to a string starting with
  `Error: github status check failed` and does not throw (FR-007, SC-003).

### Implementation for User Story 2

- [X] T011 [US2] In `src/providers/provider-status.ts`, complete the failure paths:
  - `classifyResponse`: non-2xx gives `{ kind: "http", status }`; 2xx with a failed `safeParse`
    gives `{ kind: "invalid" }`;
  - `classifyError(error: unknown)`: `name` `TimeoutError` or `AbortError` gives `timeout`,
    anything else `network`;
  - `isRetryable(failure: Failure): boolean`, the R2 table. Left as `TODO(human)` for the
    learner during `/speckit-implement`;
  - `formatFailure(provider, failure, attempts)`: the contract's text, detail from the last
    attempt's failure, with `after 2 attempts` only when `attempts === 2`;
  - `checkProviderStatus`: a loop of at most two attempts. The whole attempt (the `fetch` call,
    `response.json()`, and classify) sits in one `try`, so a sync throw, a rejection, or a body
    read error goes through `classifyError`. Retry only when `attempt === 1` and
    `isRetryable(failure)`; otherwise return `{ ok: false, failure, attempts }`. A fresh
    `AbortSignal.timeout(timeoutMs)` per attempt. Never throws.
  Makes T008 and T009 pass.
- [X] T012 [US2] In `src/agents/tools.ts`, map `{ ok: false }` in the `check_provider_status`
  handler to `formatFailure(provider, result.failure, result.attempts)`. Makes T010 pass.

**Checkpoint**: `npm test` green with the network off. US1 and US2 both work.

---

## Phase 5: User Story 3 - The model knows when to call it (Priority: P2)

**Goal**: The tool definition follows the six description rules from the contract.

**Independent Test**: Read the tool definition: it names the situations that call for it, points
to `list_alerts` and `list_incidents` for internal state, its `provider` is an enum with default
`github` and its own description, and it states the return format and the `Error:` text.

### Tests for User Story 3

- [X] T013 [P] [US3] In `src/agents/tools.test.ts`, under `describe("tool definitions")` (fails
  until T014):
  - extend "uses enums for every status and severity" to also check the key `provider`, and
    rename it "uses enums for every status, severity, and provider";
  - add "check_provider_status says when to use it": the description includes `list_alerts`,
    `list_incidents`, `Error:`, and `none`;
  - add: `CheckProviderStatusInput.parse({}).provider === "github"`.
  The existing "describes every argument" test now covers `provider` with no change.

### Implementation for User Story 3

- [X] T014 [US3] In `src/agents/tools.ts`, replace the placeholder description of
  `check_provider_status` with the six-rule text from the
  [contract](contracts/check-provider-status.md#description-six-rules): what it does; when to use
  it (GitHub Actions, git pushes, or webhooks failing; CDN, DNS, or edge errors; "is it ours or the
  provider's?"; a dependency looks down); not for internal services, use `list_alerts` and
  `list_incidents`; the return line and the meaning of `none`, `minor`, `major`, `critical`; the
  `Error:` text. In `src/domain/schemas.ts`, finish the `provider` describe text so it names
  `github` (GitHub, including Actions and webhooks) and `cloudflare` (CDN, DNS, edge) and the
  default. Makes T013 pass.

**Checkpoint**: all three stories done; `npm run typecheck` and `npm test` green.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T015 [P] In `README.md`, add `check_provider_status` to the tool list on the line that names
  `get_runbook`, noting it queries the public GitHub and Cloudflare status pages and needs no key.
- [X] T016 Run `npm run typecheck` and `npm test`; then run `npm test` again with the network off
  (for example Wi-Fi off) and confirm the same result (SC-005, [quickstart.md](quickstart.md)).
- [ ] T017 Manual check from [quickstart.md](quickstart.md#manual-validation-live-model-and-network):
  `npm run dev`, ask "GitHub Actions is failing for us. Is it GitHub or is it us?" and "is
  Cloudflare down?", and confirm one `check_provider_status` call each with the right provider
  and a one-line result (SC-001). Needs network and the OpenRouter key; skip if unavailable and
  say so.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup. T003 imports the `Provider` type from T002, so T002
  goes first. Blocks every story.
- **US1 (Phase 3)**: after Foundational.
- **US2 (Phase 4)**: after US1. It extends `classifyResponse` and `checkProviderStatus` from T006
  and the tool handler from T007.
- **US3 (Phase 5)**: after US1 (needs the tool to exist). Independent of US2, so it can run
  beside US2.
- **Polish (Phase 6)**: after all stories.

### Within each story

- Test tasks first, and they must fail.
- Module (`src/providers/provider-status.ts`) before the tool (`src/agents/tools.ts`).
- Checkpoint gates before the next phase.

### Parallel opportunities

- T004 and T005: different test files.
- T008 and T010: different files. T009 shares a file with T008, so it follows T008.
- US3 (T013, T014) can run beside US2 once US1 is done; T013 and T010 both edit
  `src/agents/tools.test.ts`, in different `describe` blocks, so merge them with care.
- T015 beside T016.

## Parallel Example: User Story 1

```text
Task: "T004 provider-status.test.ts success tests"
Task: "T005 tools.test.ts six names and default provider"
```

## Parallel Example: User Story 2

```text
Task: "T008 + T009 provider-status.test.ts pure and loop tests"
Task: "T010 tools.test.ts failure returns Error: text"
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 1, Phase 2.
2. Phase 3 (US1). Stop and check: the tool answers on the happy path.
3. The MVP is not safe to ship alone: without US2, a network error throws out of the tool. US1 and
   US2 are both P1 and ship together.

### Incremental delivery

1. Setup + Foundational: types compile.
2. US1: happy path, tested.
3. US2: retry and never-throw, tested. First shippable point.
4. US3: full description, so the model calls the tool at the right time.
5. Polish: README, offline test run, manual check.

## Notes

- `isRetryable` (T011) is the `TODO(human)` contribution in `/speckit-implement`.
- No commit is part of these tasks; commit only when asked.
