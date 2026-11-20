# Research: Provider Status Tool

No `NEEDS CLARIFICATION` remained in the Technical Context. The decisions below settle the design
choices, starting from the reference sketch
`docs/code-examples/example-referencia-retorno-aplicacao.ts`.

## R1. What to keep and what to fix from the reference sketch

**Decision**: Keep its shape: a `const` URL table keyed by provider, a zod schema
`{ status: { indicator, description } }`, a loop of at most two attempts, `AbortSignal.timeout`
per attempt, and `fetch` as a parameter with the global `fetch` as default. Fix these defects:

| # | In the sketch | Problem | In the plan |
| --- | --- | --- | --- |
| 1 | `if (response.ok) return "... respondeu HTTP ..."` | Inverted: every success returns the HTTP text and the body is never parsed. | A non-ok, non-5xx response (4xx) is a final `http` failure; only an ok response is parsed. |
| 2 | Key `claudeflare` | Typo; the spec's enum value is `cloudflare`. | Key `cloudflare`. |
| 3 | `https://githubstatus.com/...` | No `www`; it costs a redirect and differs from FR-002. | `https://www.githubstatus.com/api/v2/status.json`. |
| 4 | `statusSchema.parse` inside the `try` | A bad body throws into the `catch` and is retried, against FR-004. | `safeParse`; an invalid body is a final `invalid` failure, not retried. |
| 5 | Multi-line Portuguese text with `${error}` | Breaks the one-line rule, mixes languages with the other tools, and dumps raw error text. | One English line with the `Error:` prefix and a failure kind. |

It also has `return "unreachable"` inside the loop, which ends the loop after the first attempt
when nothing returns; the plan's loop returns only from explicit outcomes.

**Kept on purpose**: the sketch's failure text tells the model what to do next ("answer from the
internal alerts and warn the on-call engineer of the limitation"). The failure text keeps that
guidance, in English, so a failed check still steers the model (see the contract).

**Alternatives considered**: Copy the sketch as is (rejected for the defects above); a retry
library (rejected: one retry is three lines and the constitution bars new dependencies without
need).

## R2. Retry classification

**Decision**: Each attempt ends in one of five outcomes:

| Outcome | Cause | Retry? |
| --- | --- | --- |
| `ok` | 2xx and the body passes the schema | no (done) |
| `timeout` | The attempt's signal fired (`TimeoutError`) | yes, once |
| `network` | `fetch` rejected for any other reason (DNS, reset, TLS) | yes, once |
| `http` 5xx | Server error | yes, once |
| `http` 4xx | Client error, including 404 and 429 | no |
| `invalid` | 2xx but the body is not JSON or fails the schema | no |

**Rationale**: 5xx and network failures are often brief; a 4xx or a bad body will repeat, so a
retry only adds up to 5 s during an incident. A timeout is a network failure (spec assumption).
429 is a 4xx and is not retried, since an immediate retry would not respect a rate limit.

**Alternatives considered**: Retry 429 too (rejected: would need to read `Retry-After` and wait,
beyond scope); retry invalid bodies (rejected: FR-004).

## R3. Timeout mechanics

**Decision**: Each attempt calls `fetch(url, { signal: AbortSignal.timeout(timeoutMs) })` and
reads the body under the same signal. `timeoutMs` defaults to 5000 and is injectable. An error
whose `name` is `"TimeoutError"` (the `DOMException` that `AbortSignal.timeout` raises) is
classified as `timeout`; an `"AbortError"` from the same signal is treated the same way, since
some `fetch` versions surface the abort under that name.

**Rationale**: `AbortSignal.timeout` is what the request names and needs no timer cleanup. One
signal per attempt gives each attempt its own 5 s budget (FR-003). Reading the body under the
same signal also covers a server that sends headers and then stalls.

**Testing**: inject `timeoutMs: 20` and a fake `fetch` that returns a promise rejected only when
`init.signal` fires. That proves the signal reaches `fetch`, and the test runs in about 40 ms
instead of 10 s.

**Alternatives considered**: `setTimeout` plus `AbortController` (rejected: more code and a timer
to clear); a fake that rejects at once with a `TimeoutError` (kept as an extra, cheap case, but it
does not prove the wiring on its own).

## R4. Failures as values, not exceptions

**Decision**: `checkProviderStatus` returns
`{ ok: true; status } | { ok: false; failure }` and never throws. The whole attempt body sits in a
`try`, so even an unexpected error (for example a fake `fetch` that throws synchronously) becomes
a `network` failure. The tool turns the result into text with `formatStatusLine` or
`formatFailure`.

**Rationale**: FR-007 says an error is an observation and nothing may throw out of the tool.
Constitution III asks for domain error classes, but a provider outage is not a broken domain rule,
and throwing would need a second `try` in the tool. The existing `toToolText` re-throws anything
that is not a `DomainError`, so the new tool does not use it.

**Alternatives considered**: A `ProviderStatusError extends DomainError` thrown and caught by
`toToolText` (rejected: the throw is only there to be caught one line up, and a bug in the catch
path would crash the run, which is the case FR-007 guards against).

## R5. Result format

**Decision**:

- Success: `<provider>: <indicator> - <description>`, for example
  `github: minor - Partial System Outage`. Whitespace runs (including line breaks) in the
  description collapse to one space, and the line is cut at 200 characters with `…`.
- Failure: `Error: <provider> status check failed (<kind detail>). Answer from internal alerts and
  tell the engineer the provider status is unknown.` Kind details: `timed out after 2 attempts`,
  `network error after 2 attempts`, `HTTP 503 after 2 attempts`, `HTTP 404`, `invalid response`.

**Rationale**: One line keeps the context small (spec). The provider name lets the model tell two
results apart. The failure text keeps the sketch's guidance (R1) and the `Error:` prefix the other
tools already use. The raw error message is left out: it is noise for the model and could be long.

**Alternatives considered**: JSON like the other tools (rejected: the request asks for one compact
line); include the raw error (rejected above).

## R6. Where the module lives and how it is injected

**Decision**: `src/providers/provider-status.ts`, called from `src/agents/tools.ts`.
`createTools(store, deps = {})` takes `deps: { fetch?: FetchLike; timeoutMs?: number }` and passes
it to `checkProviderStatus`. `FetchLike` is
`(url: string, init: { signal: AbortSignal }) => Promise<Response>`, which the global `fetch`
satisfies.

**Rationale**: A narrow `FetchLike` makes fakes trivial (no need to type all of `fetch`). An
optional second argument leaves the six existing `createTools(store)` call sites unchanged.
`src/providers/` keeps outside HTTP separate from SQL in `src/store/`, both in the Model layer.

**Alternatives considered**: A separate `createProviderTools(deps)` (rejected: entry points would
each need to merge two tool lists); a module-level settable fetch (rejected: shared mutable state,
not a pure design).

## R7. Response schema strictness

**Decision**: `StatusPageBody = z.object({ status: z.object({ indicator: z.string().trim().min(1),
description: z.string().trim().min(1) }) })`. Extra fields are stripped (zod default). The
indicator is not an enum.

**Rationale**: statuspage.io documents `none | minor | major | critical`, but the spec says an
unknown non-empty value must pass through (edge case), so a strict enum would turn a real status
into a false `invalid` failure. Empty strings are rejected because a blank line would tell the
model nothing.

**Alternatives considered**: `z.enum([...]).or(z.string())` (rejected: same behaviour, more
noise).
