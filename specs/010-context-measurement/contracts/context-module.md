# Contract: `src/context/`

Pure module: no store, HTTP, or model call. Used by the agents (through `LlmCallCounter`) and by
`chat-service`.

## `tokens.ts`

```ts
/** ceil(text.length / 4); 0 for "". Never throws. */
export function estimateTokens(text: string): number;

/**
 * The input tokens a finished model call reported: the sum of `usage_metadata.input_tokens` over
 * the output's chat generations whose message carries a non-negative integer value. undefined
 * when none does.
 */
export function promptTokensOf(output: LLMResult): number | undefined;

/** Nullable sum: null stays null only while nothing was reported (see data-model.md). */
export function addPromptTokens(total: number | null, more: number | null | undefined): number | null;
```

| Call | Result |
| --- | --- |
| `estimateTokens("")` | `0` |
| `estimateTokens("a")` | `1` |
| `estimateTokens("abcd")` | `1` |
| `estimateTokens("abcde")` | `2` |
| `estimateTokens("x".repeat(400))` | `100` |
| `promptTokensOf` of a generation with `usage_metadata: { input_tokens: 120, … }` | `120` |
| `promptTokensOf` of a generation without `usage_metadata` | `undefined` |
| `promptTokensOf` with `input_tokens: -1`, `1.5`, or `NaN` | `undefined` |
| `promptTokensOf` of `{ generations: [] }` | `undefined` |
| `addPromptTokens(null, undefined)` | `null` |
| `addPromptTokens(null, 0)` | `0` |
| `addPromptTokens(100, null)` | `100` |
| `addPromptTokens(100, 50)` | `150` |

## `breakdown.ts`

```ts
export interface ContextTexts {
  system: string;
  tools: string;
  history: string;
  memories: string;
  message: string;
}

export interface ContextBreakdown {
  system: number;
  tools: number;
  history: number;
  memories: number;
  message: number;
  total: number;
}

/** Each source estimated with estimateTokens; total is the sum of the five. */
export function contextBreakdown(texts: ContextTexts): ContextBreakdown;

/** The provider-facing tool definitions as one string: JSON.stringify(tools.map(convertToOpenAITool)). "[]" for no tools. */
export function toolDefinitionsText(tools: readonly StructuredToolInterface[]): string;
```

Spec example: a 400-character system prompt, 800 characters of tools, 1,000 characters of
history, no memories, and a 40-character message give
`{ system: 100, tools: 200, history: 250, memories: 0, message: 10, total: 560 }`.

`toolDefinitionsText` of `[]` is `"[]"`, which estimates to 1. A request without tools does not
exist in the app (react always has the ops tools). The spec's "0 for no source" applies to
history and memories, whose blocks are `""` when empty.

## `LlmCallCounter` (`src/agents/llm-counter.ts`)

```ts
export class LlmCallCounter extends BaseCallbackHandler {
  count: number;                // unchanged: +1 per handleChatModelStart
  promptTokens: number | null;  // new: starts null; handleLLMEnd adds promptTokensOf(output)
}
```

`awaitHandlers = true` stays, so both fields are final when the run's stream ends.

## `history.ts` and `memories.ts`

```ts
/** "" for no history; otherwise everything composeInput adds ahead of the message. */
export function historyBlock(history: readonly NewMessage[]): string;
// composeInput(history, message) === historyBlock(history) + message   (output unchanged)

/** "" for no memories; otherwise everything composeMemoryInput adds ahead of the input. */
export function memoryBlock(memories: readonly Pick<Memory, "id" | "fact">[]): string;
// composeMemoryInput(memories, input) === memoryBlock(memories) + input   (output unchanged)
```

`withHistory`, `withMemories`, and `withReflection` copy the wrapped strategy's `systemPrompt`
when it has one, and leave the key out when it does not. That way `deepEqual` checks on wrapped
fake strategies stay stable.
