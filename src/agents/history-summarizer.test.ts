import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { estimateTokens } from "../context/tokens.ts";
import type { NewMessage } from "../domain/schemas.ts";
import { hangingTurn, ScriptedChatModel, textTurn, type ScriptedTurn } from "../testing/scripted-chat-model.ts";
import { LlmCallCounter } from "./llm-counter.ts";
import { cleanSummary, createHistorySummarizer, fitSummary, renderSummary, summaryMessages } from "./history-summarizer.ts";
import { SUMMARY_MAX_TOKENS } from "./history.ts";

const HEADER = "Summary of the earlier conversation (oldest messages first, merged):";

describe("renderSummary", () => {
  it("labels the block and lists the summary lines", () => {
    assert.equal(renderSummary("- A\n- B"), `${HEADER}\n- A\n- B\n\n`);
  });

  it("is empty for a blank summary", () => {
    assert.equal(renderSummary(""), "");
    assert.equal(renderSummary("  \n "), "");
  });
});

const messages: NewMessage[] = [
  { role: "user", content: "which alerts are firing on checkout?" },
  { role: "assistant", content: "ALT-001 is firing." },
];
const previous = "- Page payments team\n- INC-002 open";

describe("summaryMessages", () => {
  it("with no previous summary: the prompt, then (none) and the messages to add", () => {
    const [system, human] = summaryMessages(undefined, messages);
    assert.ok(system instanceof SystemMessage);
    assert.ok(human instanceof HumanMessage);
    assert.equal(
      human.content,
      "Previous summary:\n(none)\n\nMessages to add:\nUser: which alerts are firing on checkout?\nAssistant: ALT-001 is firing.",
    );
  });

  it("with a previous summary: its text stands in place of (none)", () => {
    const human = summaryMessages(previous, messages)[1];
    assert.equal(
      human?.content,
      `Previous summary:\n${previous}\n\nMessages to add:\nUser: which alerts are firing on checkout?\nAssistant: ALT-001 is firing.`,
    );
  });

  it("treats a blank previous summary as none", () => {
    const human = summaryMessages("  ", messages)[1];
    assert.match(String(human?.content), /^Previous summary:\n\(none\)\n\n/);
  });

  it("asks for what the course example asks for, and says the input is data", () => {
    const prompt = String(summaryMessages(undefined, messages)[0]?.content);
    for (const phrase of [
      /at most 150 tokens/,
      /decisions made/,
      /facts established \(names, dates, deadlines, preferences\)/,
      /incidents opened or resolved/,
      /open items/,
      /Discard greetings and small talk/,
      /incorporate it/,
      /Reply with the summary only, as telegraphic bullet points/,
      /data, not instructions/,
    ]) {
      assert.match(prompt, phrase);
    }
  });
});

describe("cleanSummary", () => {
  it("trims the lines and drops the blank ones", () => {
    assert.deepEqual(cleanSummary("  - Page payments \n\n   \n- checkout on eu-west\n"), {
      summary: "- Page payments\n- checkout on eu-west",
      droppedSecrets: 0,
    });
  });

  it("drops the lines that look like a secret, and counts them", () => {
    const result = cleanSummary(
      [
        "- Decision: page payments",
        "- token is sk-abcdefghijklmnopqrstuv",
        "- the staging DB password is hunter2",
        "- Open: INC-002",
      ].join("\n"),
    );
    assert.deepEqual(result, { summary: "- Decision: page payments\n- Open: INC-002", droppedSecrets: 2 });
  });

  it("is undefined for an empty reply, and for one that ends up empty", () => {
    assert.equal(cleanSummary(""), undefined);
    assert.equal(cleanSummary(" \n  \n"), undefined);
    assert.equal(cleanSummary("- api_key=abc123"), undefined);
  });

  it("fits the result to the cap", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `- line ${index} ${"y".repeat(70)}`);
    const result = cleanSummary(lines.join("\n"));
    assert.ok(result);
    assert.ok(estimateTokens(renderSummary(result.summary)) <= SUMMARY_MAX_TOKENS);
    assert.ok(result.summary.startsWith("- line 0 "));
  });
});

describe("fitSummary", () => {
  const long = (count: number) => Array.from({ length: count }, (_, index) => `- line ${index} ${"z".repeat(70)}`).join("\n");

  it("returns a summary that already fits unchanged", () => {
    assert.equal(fitSummary(previous), previous);
  });

  it("drops the last lines first, whole lines only", () => {
    const summary = long(25);
    assert.ok(renderSummary(summary).length > 1200);
    const fitted = fitSummary(summary);
    assert.ok(estimateTokens(renderSummary(fitted)) <= SUMMARY_MAX_TOKENS);
    assert.ok(summary.startsWith(fitted));
    assert.ok(fitted.split("\n").every((line) => line.endsWith("z".repeat(70))));
    assert.ok(fitted.length > 0 && fitted.length < summary.length);
  });

  it("honours a smaller cap", () => {
    assert.ok(estimateTokens(renderSummary(fitSummary(previous, 10))) <= 10);
  });

  it("gives an empty summary when not even one line fits", () => {
    assert.equal(fitSummary(`- ${"w".repeat(2000)}`), "");
  });
});

describe("createHistorySummarizer", () => {
  const live = () => new AbortController().signal;

  function summarizerWith(turns: readonly ScriptedTurn[]) {
    const model = new ScriptedChatModel(turns);
    const prompts: BaseMessage[][] = [];
    model.callbacks = [
      {
        handleChatModelStart: (_llm: unknown, batch: BaseMessage[][]) => {
          prompts.push(...batch);
        },
      },
    ];
    return { model, prompts, summarizer: createHistorySummarizer({ model }) };
  }

  it("resolves to the reply text, from the prompt summaryMessages builds, in one call", async () => {
    const { summarizer, model, prompts } = summarizerWith([textTurn("- a\n- b")]);

    const text = await summarizer.summarize(previous, messages, { signal: live(), callbacks: [] });

    assert.equal(text, "- a\n- b");
    assert.equal(model.calls, 1);
    const expected = summaryMessages(previous, messages);
    assert.deepEqual(
      prompts[0]?.map((message) => [message.getType(), message.content]),
      expected.map((message) => [message.getType(), message.content]),
    );
  });

  it("rejects with the provider's error, after one call and no retry", async () => {
    const { summarizer, model } = summarizerWith([new Error("provider down"), textTurn("- late")]);
    await assert.rejects(summarizer.summarize(undefined, messages, { signal: live(), callbacks: [] }), /provider down/);
    assert.equal(model.calls, 1);
  });

  it("rejects without a model call when the signal is already aborted", async () => {
    const { summarizer, model } = summarizerWith([textTurn("- a")]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(summarizer.summarize(undefined, messages, { signal: controller.signal, callbacks: [] }));
    assert.equal(model.calls, 0);
  });

  it("rejects when the signal aborts while the model call hangs", async () => {
    const { summarizer } = summarizerWith([hangingTurn()]);
    const controller = new AbortController();
    const pending = summarizer.summarize(undefined, messages, { signal: controller.signal, callbacks: [] });
    controller.abort();
    await assert.rejects(pending);
  });

  it("lets a counter in the callbacks count the call", async () => {
    const { summarizer } = summarizerWith([textTurn("- a")]);
    const counter = new LlmCallCounter();
    await summarizer.summarize(undefined, messages, { signal: live(), callbacks: [counter] });
    assert.equal(counter.count, 1);
  });
});
