# Data Model: History Summarization

## Table `conversation_summaries` (SQLite, same file as `conversations`)

```sql
CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  summary TEXT NOT NULL CHECK (length(trim(summary, ' ' || char(9) || char(10) || char(13))) > 0),
  covered_messages INTEGER NOT NULL CHECK (covered_messages > 0),
  updated_at TEXT NOT NULL
) STRICT;
```

| Column | Rule |
| --- | --- |
| `conversation_id` | One row per conversation, at most. Foreign key to `conversations(id)`. |
| `summary` | The merged summary: telegraphic bullet lines, one per line, trimmed and not blank (zod on read and write). |
| `covered_messages` | How many of the conversation's oldest messages, in `messages.id` order, the summary covers. Always > 0. Never decreases. |
| `updated_at` | ISO timestamp of the last save. |

Every value is bound through a prepared statement. A row read back is parsed with zod, so a
hand-edited row fails loudly, the same rule as `messages`.

## ConversationSummary (domain, `src/domain/schemas.ts`)

```ts
SummaryText = z.string().trim().min(1)
ConversationSummary = z.object({ conversationId: z.string().min(1), summary: SummaryText, coveredMessages: z.number().int().positive(), updatedAt: z.string() })
```

## Constants (`src/agents/history.ts`)

| Name | Value | Meaning |
| --- | --- | --- |
| `HISTORY_WINDOW` | 8 | Newest messages always given word for word (FR-001) |
| `SUMMARY_BATCH` | 8 | Uncovered messages outside the window that trigger a summarization (FR-004) |
| `MAX_VERBATIM` | 14 | Most messages given word for word, also after a failed summarization (SC-003) |
| `SUMMARY_MAX_TOKENS` | 300 | Cap on the rendered summary, measured with `estimateTokens` (FR-006) |

They replace `HISTORY_LIMIT = 12`.

## HistoryPlan (pure, `planHistory`)

Input: the uncovered messages, oldest first. Output:

With `outside = length - 8`:

| Case | `toSummarize` | `verbatim` |
| --- | --- | --- |
| due: `outside >= 8 && outside % 8 < 2` | `uncovered.slice(0, outside)` | the last 8 |
| not due | `[]` | `uncovered.slice(-14)` (all of them while there are 14 or fewer) |

When a due summarization then fails, the agent gets `uncovered.slice(-14)`.

After a failure at exchange 9 (outside = 8), exchanges 10 to 12 (outside 10, 12, 14) are not due.
Exchange 13 (outside 16) is due again and absorbs all 16 messages.

Example over exchanges (2 messages each, all successes):

| Exchange | Earlier messages | Covered before | Uncovered | Summarizes | Verbatim given |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | no | 0 |
| 5 | 8 | 0 | 8 | no | 8 |
| 8 | 14 | 0 | 14 | no | 14 |
| 9 | 16 | 0 | 16 | 8 messages | 8 |
| 12 | 22 | 8 | 14 | no | 14 |
| 13 | 24 | 8 | 16 | 8 messages | 8 |
| 17 | 32 | 16 | 16 | 8 messages | 8 |

## Summary lifecycle

```text
(none) --first batch summarized--> covered = 8
covered = c --next batch of k >= 8 summarized, CAS on c--> covered = c + k
covered = c --summarization fails / empty / CAS lost--> covered = c (unchanged)
```

`saveSummary(id, summary, expectedCovered, coveredMessages)` stores only when the stored coverage is
still `expectedCovered`:

- `INSERT … ON CONFLICT DO NOTHING` when `expectedCovered` is 0.
- `UPDATE … WHERE covered_messages = ?` otherwise.

It returns whether it wrote.

## Summarizer reply

A string: the model's answer to one plain call. `cleanSummary` turns it into the stored summary:

1. Split into lines, trim every line, and drop the blank ones.
2. Drop the lines `looksLikeSecret` flags, and count them.
3. `fitSummary` to 300 estimated tokens: drop whole lines from the end.
4. Join the lines with `\n`. When no line is left, return `undefined` (a failure, FR-010 and
   FR-013).

## TraceEvent `summarize`

| Field | Type | Rule |
| --- | --- | --- |
| `type` | `"summarize"` | literal |
| `content` | string | `renderSummary` of the stored summary, as the agent got it |
| `absorbed` | integer ≥ 1 | number of messages this summarization added to the coverage |

It appears only on a reply whose summarization stored a new summary, as the first trace event.

## SummarizationStep (service, internal)

| Outcome | Data | Reply effect |
| --- | --- | --- |
| `stored` | summary, rendered, absorbed, droppedSecrets, llmCalls, promptTokens | event prepended; calls and tokens added to metrics |
| `failed` | reason: `thrown` (error), `timeout`, `empty`, `conflict`; llmCalls, promptTokens | no event; answer and trace as without a summary (FR-010). The calls that finished are still added to the metrics, because they were paid for (research R7) |
| `not_due` | none | none |
