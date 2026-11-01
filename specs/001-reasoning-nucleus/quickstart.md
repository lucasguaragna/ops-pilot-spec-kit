# Quickstart: Reasoning Nucleus

Validation guide. Contracts are in [contracts/](contracts/).

## Without a provider

Prerequisite: `npm ci`.

1. `npm run seed` prints 5 services, 3 firing alerts, and 3 resolved alerts.
2. `npm test` passes with network access disabled, and `npm run typecheck` passes.
3. `npm run arena -- --strategies unknown` exits with code `2` before any strategy runs.
4. `npm run arena -- --max-iterations 0` exits with code `2`.
5. `npm run arena` with no provider settings names the missing setting, prints no secret, and exits
   with code `1`.

## With OpenRouter

Prerequisite: `.env` created from `.env.example`, with `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`.

1. `npm run arena -- --strategies react --input "List firing alerts"` prints an action for
   `list_alerts`, its observation, an answer, and metrics.
2. `npm run arena -- --strategies plan-execute --input "List firing alerts and open an incident for
   the most severe one"` prints a plan, then each step, then an answer.
3. `npm run arena` runs both strategies on the same input.
4. `npm run arena -- --max-iterations 1` shows stop reason `iteration_limit` on a multi-step request.
5. Confirm `withStructuredOutput` works with the chosen model. This is unverified in
   [research.md](research.md).
