# Quickstart: Reflection Layer

Validation guide. The contract is in [contracts/reflection.md](contracts/reflection.md).

## Without a provider

Prerequisite: `npm ci`.

1. `npm test` passes with network access disabled, and `npm run typecheck` passes.
2. `npm run arena -- --strategies reflect:unknown` exits with code `2` and lists the known names,
   including `reflect:react` and `reflect:plan-execute`.

## With OpenRouter

Prerequisite: `.env` with `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. Run `npm run seed` before
each step so runs start from the seed.

1. `npm run arena -- "how many critical alerts are firing?" --strategies react,reflect:react`
   prints a `[critique]` line only for `reflect:react`, and its `llmCalls` is higher.
2. `npm run arena -- "abra 3 incidentes sev2 para os alertas do checkout, payments e catalog, nessa
   ordem, e resolva o primeiro" --strategies reflect:plan-execute` prints at least one critique.
   Check `data/db.json` afterwards: the final answer must match the stored incidents.
3. Count attempts in a run: never more than 3 with the default limit.
