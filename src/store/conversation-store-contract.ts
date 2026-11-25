import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConversationNotFoundError } from "../domain/errors.ts";
import type { ConversationStore } from "./conversation-store.ts";

export const CONTRACT_NOW = "2026-11-20T12:00:00.000Z";

const SUMMARY_A = "- Page the payments team\n- checkout-api runs on eu-west\n- INC-002 stays open";
const SUMMARY_B = "- Page the payments team\n- Roll back the deploy";

export interface ConversationStoreOptions {
  now: () => string;
  newId: () => string;
}

/**
 * Behaviour every ConversationStore must share. Not a *.test.ts file, so the runner only loads it
 * through the store test files that import it.
 */
export function runConversationStoreContract(
  label: string,
  makeStore: (options: ConversationStoreOptions) => ConversationStore,
): void {
  describe(`ConversationStore contract: ${label}`, () => {
    const fresh = () => {
      let counter = 0;
      return makeStore({ now: () => CONTRACT_NOW, newId: () => `conv-${++counter}` });
    };

    it("creates an empty conversation", () => {
      const store = fresh();
      const conversation = store.create();
      assert.equal(conversation.createdAt, CONTRACT_NOW);
      assert.deepEqual(store.lastMessages(conversation.id, 12), []);
    });

    it("gives every conversation a different id", () => {
      const store = fresh();
      assert.notEqual(store.create().id, store.create().id);
    });

    it("returns the stored message with its conversation, role, content, and time", () => {
      const store = fresh();
      const { id } = store.create();
      const stored = store.append(id, { role: "user", content: "which alerts are firing?" });
      assert.equal(stored.conversationId, id);
      assert.equal(stored.role, "user");
      assert.equal(stored.content, "which alerts are firing?");
      assert.equal(stored.createdAt, CONTRACT_NOW);
      assert.equal(typeof stored.id, "number");
    });

    it("returns the messages in the order they were appended", () => {
      const store = fresh();
      const { id } = store.create();
      store.append(id, { role: "user", content: "first" });
      store.append(id, { role: "assistant", content: "second" });
      store.append(id, { role: "user", content: "third" });
      assert.deepEqual(
        store.lastMessages(id, 12).map((message) => [message.role, message.content]),
        [
          ["user", "first"],
          ["assistant", "second"],
          ["user", "third"],
        ],
      );
    });

    it("returns only the newest messages, oldest first, when there are more than the limit", () => {
      const store = fresh();
      const { id } = store.create();
      for (let n = 1; n <= 20; n++) store.append(id, { role: n % 2 === 1 ? "user" : "assistant", content: `m${n}` });
      const contents = store.lastMessages(id, 12).map((message) => message.content);
      assert.deepEqual(contents, Array.from({ length: 12 }, (_, index) => `m${index + 9}`));
    });

    it("returns every message when there are fewer than the limit", () => {
      const store = fresh();
      const { id } = store.create();
      for (let n = 1; n <= 5; n++) store.append(id, { role: "user", content: `m${n}` });
      assert.equal(store.lastMessages(id, 12).length, 5);
    });

    it("returns nothing for a limit of 0", () => {
      const store = fresh();
      const { id } = store.create();
      store.append(id, { role: "user", content: "hi" });
      assert.deepEqual(store.lastMessages(id, 0), []);
    });

    it("keeps messages of one conversation out of another", () => {
      const store = fresh();
      const a = store.create();
      const b = store.create();
      store.append(a.id, { role: "user", content: "for a" });
      store.append(b.id, { role: "user", content: "for b" });
      assert.deepEqual(store.lastMessages(a.id, 12).map((message) => message.content), ["for a"]);
      assert.deepEqual(store.lastMessages(b.id, 12).map((message) => message.content), ["for b"]);
    });

    it("stores empty and awkward text verbatim", () => {
      const store = fresh();
      const { id } = store.create();
      const awkward = "x'); DROP TABLE messages;--";
      store.append(id, { role: "user", content: awkward });
      store.append(id, { role: "assistant", content: "" });
      assert.deepEqual(store.lastMessages(id, 12).map((message) => message.content), [awkward, ""]);
    });

    it("throws ConversationNotFoundError carrying the id for an unknown conversation", () => {
      const store = fresh();
      const isNotFound = (error: unknown) =>
        error instanceof ConversationNotFoundError && error.conversationId === "missing";
      assert.throws(() => store.append("missing", { role: "user", content: "hi" }), isNotFound);
      assert.throws(() => store.lastMessages("missing", 12), isNotFound);
      assert.throws(() => store.messagesAfter("missing", 0), isNotFound);
      assert.throws(() => store.summaryOf("missing"), isNotFound);
      assert.throws(() => store.saveSummary("missing", SUMMARY_A, 0, 8), isNotFound);
    });

    describe("messagesAfter", () => {
      const withFive = () => {
        const store = fresh();
        const { id } = store.create();
        for (let n = 1; n <= 5; n++) store.append(id, { role: n % 2 === 1 ? "user" : "assistant", content: `m${n}` });
        return { store, id };
      };

      it("returns every message, oldest first, after none are covered", () => {
        const { store, id } = withFive();
        assert.deepEqual(store.messagesAfter(id, 0).map((message) => message.content), ["m1", "m2", "m3", "m4", "m5"]);
      });

      it("skips the first `covered` messages", () => {
        const { store, id } = withFive();
        assert.deepEqual(store.messagesAfter(id, 3).map((message) => message.content), ["m4", "m5"]);
      });

      it("returns nothing when more are covered than exist", () => {
        const { store, id } = withFive();
        assert.deepEqual(store.messagesAfter(id, 9), []);
      });

      it("rejects a negative count instead of binding it", () => {
        const { store, id } = withFive();
        assert.throws(() => store.messagesAfter(id, -1));
      });

      it("keeps the messages of another conversation out", () => {
        const { store, id } = withFive();
        const other = store.create();
        store.append(other.id, { role: "user", content: "elsewhere" });
        assert.equal(store.messagesAfter(id, 0).length, 5);
        assert.deepEqual(store.messagesAfter(other.id, 0).map((message) => message.content), ["elsewhere"]);
      });
    });

    describe("summaries", () => {
      it("has no summary on a new conversation", () => {
        const store = fresh();
        assert.equal(store.summaryOf(store.create().id), undefined);
      });

      it("stores the first summary and reads it back", () => {
        const store = fresh();
        const { id } = store.create();
        assert.equal(store.saveSummary(id, SUMMARY_A, 0, 8), true);
        assert.deepEqual(store.summaryOf(id), {
          summary: SUMMARY_A,
          conversationId: id,
          coveredMessages: 8,
          updatedAt: CONTRACT_NOW,
        });
      });

      it("refuses a second first summary and keeps the stored one", () => {
        const store = fresh();
        const { id } = store.create();
        store.saveSummary(id, SUMMARY_A, 0, 8);
        assert.equal(store.saveSummary(id, SUMMARY_B, 0, 8), false);
        assert.equal(store.summaryOf(id)?.summary, SUMMARY_A);
        assert.equal(store.summaryOf(id)?.coveredMessages, 8);
      });

      it("replaces the summary when the coverage still matches", () => {
        const store = fresh();
        const { id } = store.create();
        store.saveSummary(id, SUMMARY_A, 0, 8);
        assert.equal(store.saveSummary(id, SUMMARY_B, 8, 16), true);
        const stored = store.summaryOf(id);
        assert.equal(stored?.summary, SUMMARY_B);
        assert.equal(stored?.coveredMessages, 16);
      });

      it("refuses a stale compare-and-swap", () => {
        const store = fresh();
        const { id } = store.create();
        store.saveSummary(id, SUMMARY_A, 0, 8);
        store.saveSummary(id, SUMMARY_B, 8, 16);
        assert.equal(store.saveSummary(id, SUMMARY_A, 8, 24), false);
        assert.equal(store.summaryOf(id)?.coveredMessages, 16);
      });

      it("throws when the coverage does not grow", () => {
        const store = fresh();
        const { id } = store.create();
        store.saveSummary(id, SUMMARY_A, 0, 8);
        assert.throws(() => store.saveSummary(id, SUMMARY_B, 8, 8));
        assert.throws(() => store.saveSummary(id, SUMMARY_B, 8, 4));
        assert.equal(store.summaryOf(id)?.coveredMessages, 8);
      });

      it("throws for a blank summary and stores nothing", () => {
        const store = fresh();
        const { id } = store.create();
        assert.throws(() => store.saveSummary(id, "   ", 0, 8));
        assert.equal(store.summaryOf(id), undefined);
      });

      it("keeps the summaries of two conversations apart", () => {
        const store = fresh();
        const a = store.create();
        const b = store.create();
        store.saveSummary(a.id, SUMMARY_A, 0, 8);
        assert.equal(store.summaryOf(b.id), undefined);
        assert.equal(store.saveSummary(b.id, SUMMARY_B, 0, 8), true);
        assert.equal(store.summaryOf(a.id)?.summary, SUMMARY_A);
      });

      it("stores awkward text verbatim", () => {
        const store = fresh();
        const { id } = store.create();
        const awkward = "- x'); DROP TABLE messages;--\n- \"quoted\" \\ back";
        store.saveSummary(id, awkward, 0, 8);
        assert.equal(store.summaryOf(id)?.summary, awkward);
      });
    });
  });
}
