# Data Model: Provider Status Tool

Nothing is stored. These are the in-memory values the module works with.

## Provider

Closed set, a zod enum in `src/domain/schemas.ts`.

| Value | Status URL |
| --- | --- |
| `github` (default) | `https://www.githubstatus.com/api/v2/status.json` |
| `cloudflare` | `https://www.cloudflarestatus.com/api/v2/status.json` |

The URL table is a `const` record keyed by `Provider`, so adding a provider without a URL fails
type-checking.

## Status page body (outside input)

Validated with zod (`StatusPageBody`) before use. Only these fields are read; the rest is dropped.

| Field | Rule |
| --- | --- |
| `status.indicator` | string, trimmed, non-empty. Known values `none`, `minor`, `major`, `critical`; others pass through. |
| `status.description` | string, trimmed, non-empty |

## Provider status (success value)

`{ provider: Provider; indicator: string; description: string }`, rendered by
`formatStatusLine` as one line of at most 200 characters.

## Failure (failure value)

Discriminated union on `kind`:

| `kind` | Extra fields | Retryable |
| --- | --- | --- |
| `timeout` | none | yes |
| `network` | none | yes |
| `http` | `status: number` | yes when `status >= 500`, no otherwise |
| `invalid` | none | no |

The final result also carries `attempts: 1 | 2`, used in the failure text.

## Attempt outcome (internal value)

`Outcome` is what one attempt produces: `{ ok: true; indicator; description }` or
`{ ok: false; failure }`. The loop turns it into the final result. The per-attempt timeout default
is the exported constant `DEFAULT_TIMEOUT_MS` (5000).

## Check flow (state transitions)

```text
attempt 1 ──ok──────────────────────────────▶ success
    │
    ├─ invalid / http 4xx ──────────────────▶ failure (attempts 1)
    │
    └─ timeout / network / http 5xx ─▶ attempt 2 ──ok──▶ success
                                          │
                                          └─ any failure ─▶ failure (attempts 2)
```

At most two `fetch` calls per tool call.
