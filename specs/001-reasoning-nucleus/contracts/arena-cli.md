# Contract: Arena CLI

```sh
npm run arena -- [<text> | --input <text>] [--strategies <list>] [--max-iterations <n>]
```

The input can be given as text without a flag. Separate words are joined with spaces. Giving both
text and `--input` is invalid.

| Flag | Default | Rules |
| --- | --- | --- |
| `--input` | A sample multi-step request | Non-empty |
| `--strategies` | `react,plan-execute` | Comma-separated, known names only |
| `--max-iterations` | `10` | Positive integer |

## Behavior

- Flags are validated before any strategy runs.
- Each strategy gets the same input and reads and writes `data/db.json`. Changes from one strategy
  are visible to the next one and to later runs. `npm run seed` restores the seed.
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

Writes the seed to `data/db.json`, replacing its contents, and prints the service count, alert
counts per status, and incident count. Exit code `0`.
