# Quickstart: Provider Status Tool

## Prerequisites

- Node.js 22.13 or newer, dependencies installed (`npm install`).
- For the manual check only: network access and the usual OpenRouter key in `.env`.

## Automated validation (no network)

```sh
npm run typecheck
npm test
```

Expected: both pass. The provider tests live in `src/providers/provider-status.test.ts` and the
tool tests in `src/agents/tools.test.ts`; they cover the cases listed in
[contracts/check-provider-status.md](contracts/check-provider-status.md#tests). Running them with
the network off gives the same result (SC-005).

## Manual validation (live model and network)

1. `npm run dev`.
2. Send a chat message such as "GitHub Actions is failing for us. Is it GitHub or is it us?"
   (use the Insomnia collection or the OpenAPI description from feature 003).
3. Expected: the trace shows one `check_provider_status` call with `provider: github`, its result
   is a single line like `github: none - All Systems Operational`, and the reply answers in one
   sentence (SC-001).
4. Ask "is Cloudflare down?". Expected: the call uses `provider: cloudflare`.
5. Optional failure check: block the status host (for example with a hosts-file entry) and ask
   again. Expected: after about 10 s the tool returns an `Error: ... timed out after 2 attempts`
   or `network error after 2 attempts` line, the run does not crash, and the reply says the
   provider status is unknown and answers from internal alerts.
