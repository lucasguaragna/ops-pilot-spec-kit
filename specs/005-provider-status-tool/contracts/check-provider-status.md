# Contract: check_provider_status

## Tool

**File**: `src/agents/tools.ts`. `createTools(store, deps?)` returns, in this order:

```ts
[list_alerts, open_incident, resolve_incident, list_incidents, get_runbook, check_provider_status]
```

The new tool is appended, so existing destructuring keeps working. `deps` is optional:

```ts
type ToolDeps = { fetch?: FetchLike; timeoutMs?: number }; // defaults: global fetch, 5000
```

| Item | Value |
| --- | --- |
| Name | `check_provider_status` |
| Input (zod `CheckProviderStatusInput`) | `provider`: `github \| cloudflare`, default `github`, with `.describe()` naming both values and the default |
| Returns | One line: `<provider>: <indicator> - <description>`, at most 200 characters |
| Errors as text | `Error: <provider> status check failed (<detail>). Answer from internal alerts and tell the engineer the provider status is unknown.` |
| Throws | Never. Invalid input is rejected by zod before any request, as with the other tools. |

### Description (six rules)

1. **What**: checks the public status page of an external provider the team depends on.
2. **When**: an outside cause is suspected (GitHub Actions, git pushes, or webhooks failing; CDN,
   DNS, or edge errors), the engineer asks "is it ours or the provider's?", or a dependency looks
   down. Not for internal services: use `list_alerts` and `list_incidents` for those.
3. **Arguments**: `provider` has its own description.
4. **Closed sets**: `provider` is a `z.enum`, values named in the describe text.
5. **Returns**: the one-line format above; indicator `none` means operational, `minor`, `major`,
   `critical` mean degraded to down. Names the `Error:` text.
6. **Identifiers**: providers are named by the enum values only.

### Failure details

| Last attempt's failure | Detail text |
| --- | --- |
| Timeout on attempt 2 | `timed out after 2 attempts` |
| Network error on attempt 2 | `network error after 2 attempts` |
| 5xx on attempt 2 | `HTTP <code> after 2 attempts` |
| 4xx on attempt 1 | `HTTP <code>` |
| Invalid body on attempt 1 or 2 | `invalid response` |

The detail always describes the last attempt's failure.

## Module

**File**: `src/providers/provider-status.ts`

| Export | Kind | Purpose |
| --- | --- | --- |
| `STATUS_URLS` | const | `Record<Provider, string>` from the data model |
| `StatusPageBody` | zod schema | Validates the outside body |
| `FetchLike` | type | `(url: string, init: { signal: AbortSignal }) => Promise<Response>` |
| `classifyResponse(status, body)` | pure | HTTP status + parsed JSON (or a parse failure) to an attempt outcome |
| `classifyError(error)` | pure | Thrown value to `timeout` or `network` |
| `isRetryable(failure)` | pure | R2 table |
| `formatStatusLine(status)` | pure | Success line, whitespace collapsed, capped at 200 |
| `formatFailure(provider, failure, attempts)` | pure | Failure text above |
| `checkProviderStatus(provider, deps)` | edge | At most two attempts; returns a result value, never throws |

## Tests

- **Module, pure**: each R2 row through `classifyResponse` / `classifyError`; `isRetryable`;
  line collapse and 200-character cap; every failure detail.
- **Module, loop, fake fetch**: success; timeout through the real signal with `timeoutMs: 20`
  (two calls); invalid body (one call); 503 then 200 (two calls, success); 503 twice (two calls);
  404 (one call); a fake that throws synchronously (no throw escapes); the URL requested matches
  the provider.
- **Tool**: name list now has six entries; the schema-rule walk covers `provider`; called with
  `{}` it requests the GitHub URL; the result is the formatted line.
