# Contract: Arena CLI

```sh
npm run arena -- [--input <text>] [--strategies <list>] [--max-iterations <n>]
```

| Flag | Default | Rules |
| --- | --- | --- |
| `--input` | A sample multi-step request | Non-empty |
| `--strategies` | `react,plan-execute` | Comma-separated, known names only |
| `--max-iterations` | `10` | Positive integer |

## Behavior

- Flags are validated before any strategy runs.
- Each strategy gets the same input and a freshly seeded store.
- Strategies run one after another. A failure in one does not stop the rest.
- Output for each strategy, in order: name, trace, answer, stop reason, `llmCalls`, `latencyMs`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every strategy completed |
| `1` | At least one strategy stopped by limit or error |
| `2` | Invalid flags |

Errors go to stderr.

## Seed command

```sh
npm run seed
```

Loads the seed and prints the service count and alert counts per status. Exit code `0`.
