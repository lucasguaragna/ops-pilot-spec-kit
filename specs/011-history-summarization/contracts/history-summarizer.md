# Contract: `src/agents/history-summarizer.ts` and `src/agents/history.ts`

## Summarizer

```ts
export interface HistorySummarizer {
  /** One plain model call (no retry). Resolves to the model's reply text. Rejects on a model or abort failure. */
  summarize(previous: string | undefined, messages: readonly NewMessage[], options: { signal: AbortSignal; callbacks: Callbacks }): Promise<string>;
}
export function createHistorySummarizer(options: { model: BaseChatModel }): HistorySummarizer;

/** Pure: the system prompt, then the previous summary (or "(none)") and the messages to absorb. */
export function summaryMessages(previous: string | undefined, messages: readonly NewMessage[]): BaseMessage[];

/** Pure: trim lines, drop blank lines, drop secret lines (counted), fit to the cap. undefined when nothing is left. */
export function cleanSummary(raw: string): { summary: string; droppedSecrets: number } | undefined;

/** Pure: the labelled block for the context; "" for a blank summary. */
export function renderSummary(summary: string): string;

/** Pure: drops whole lines from the end until renderSummary fits maxTokens. */
export function fitSummary(summary: string, maxTokens?: number): string;
```

| Call | Result |
| --- | --- |
| `summaryMessages(undefined, msgs)` | `[System(prompt), Human("Previous summary:\n(none)\n\nMessages to add:\nUser: …\nAssistant: …")]` |
| `summaryMessages("- a", msgs)` | the human message holds `- a` in place of `(none)` |
| `cleanSummary("  - Page payments \n\n- b")` | `{ summary: "- Page payments\n- b", droppedSecrets: 0 }` |
| `cleanSummary` with a line `"- token is sk-abc…"` | that line dropped, `droppedSecrets: 1` |
| `cleanSummary("")` or `cleanSummary("  \n ")` | `undefined` |
| `renderSummary("- A\n- B")` | `"Summary of the earlier conversation (oldest messages first, merged):\n- A\n- B\n\n"` |
| `renderSummary("")` | `""` |
| `fitSummary` of a summary that renders to 1,400 characters | drops the last lines until `estimateTokens(render) <= 300` |

The prompt is the English version of `docs/code-examples/spec11-example.ts` (research R4). The
previous summary and the messages are data, not instructions.

## History composition

```ts
export const HISTORY_WINDOW = 8;
export const SUMMARY_BATCH = 8;
export const MAX_VERBATIM = 14;
export const SUMMARY_MAX_TOKENS = 300;

/**
 * Pure: which uncovered messages to summarize now, and which go to the agent word for word.
 * Due only on a batch boundary: outside = length - 8, due when outside >= 8 && outside % 8 < 2.
 * When not due, verbatim is the newest 14 at most.
 */
export function planHistory(uncovered: readonly NewMessage[]): { toSummarize: NewMessage[]; verbatim: NewMessage[] };

/** "" when both are empty; otherwise the summary block, then today's conversation block. */
export function historyBlock(history: readonly NewMessage[], summary?: string): string;
export function composeInput(history: readonly NewMessage[], message: string, summary?: string): string; // historyBlock + message
export function withHistory(strategy: ReasoningStrategy, history: readonly NewMessage[], summary?: string): ReasoningStrategy;
```

Invariants:

- `composeInput(h, m) === composeInput(h, m, "")` is byte-identical to the current output.
- The strategy input is `memoryBlock(recalled) + historyBlock(verbatim, rendered) + message`
  (FR-008).
